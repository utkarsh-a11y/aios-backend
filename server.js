// =====================================================================
// AIOS Backend — runs on RENDER (browser ke andar nahi, isliye SAFE)
// Yahan aapki AI key aur payment logic hai — koi copy nahi kar sakta.
// =====================================================================
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Razorpay = require('razorpay');

const app = express();

// Razorpay webhook needs RAW body for signature check — capture it
app.use('/webhook/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// ---- ENV VARS (Render Dashboard > Environment me daalna) ----
const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,   // service key = backend-only, bypasses RLS
  ANTHROPIC_API_KEY,                     // aapki Claude key — SAFE yahan
  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

// ---- MODEL CONFIG + ROUTER ----
const MODELS = {
  opus:   { api: 'claude-opus-4-20250514',     px: 18 },
  sonnet: { api: 'claude-sonnet-4-6',          px: 8  },
  haiku:  { api: 'claude-haiku-4-5-20251001',  px: 3  },
};
function pickModel(prompt, manual) {
  if (manual && MODELS[manual]) return { id: manual, why: 'manual' };
  const p = (prompt || '').toLowerCase();
  if (/code|function|bug|sql|python|javascript|api|debug|refactor/.test(p)) return { id: 'sonnet', why: 'code+quality' };
  if (/why|explain|analyze|strategy|reason|compare|decide|plan/.test(p))    return { id: 'opus',   why: 'deep-reasoning' };
  if (p.length < 40) return { id: 'haiku', why: 'cost-optimized' };
  return { id: 'sonnet', why: 'balanced-default' };
}

// ---- AUTH: verify the Supabase JWT the frontend sends ----
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'login required' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'invalid session' });
  req.user = data.user;
  next();
}

// =====================================================================
// GET /wallet — user apna balance + usage dekhta hai
// =====================================================================
app.get('/wallet', auth, async (req, res) => {
  const uid = req.user.id;
  const { data: wallet } = await supabase.from('wallets').select('balance_credits').eq('user_id', uid).single();
  const { data: usage } = await supabase.from('usage_events').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(20);
  res.json({ balance: wallet?.balance_credits ?? 0, usage: usage || [] });
});

// =====================================================================
// POST /chat — AI call (credits check -> Claude -> deduct -> log)
// =====================================================================
app.post('/chat', auth, async (req, res) => {
  const uid = req.user.id;
  const { messages, model: manual } = req.body;
  const lastMsg = messages?.[messages.length - 1]?.content || '';
  const picked = pickModel(lastMsg, manual);
  const cfg = MODELS[picked.id];

  // 1. check balance
  const { data: wallet } = await supabase.from('wallets').select('balance_credits').eq('user_id', uid).single();
  if (!wallet || wallet.balance_credits < cfg.px) {
    return res.status(402).json({ error: 'insufficient_credits', need: cfg.px, have: wallet?.balance_credits ?? 0 });
  }

  // 2. call Claude
  const t0 = Date.now();
  let reply = '', tokens = 0;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.api, max_tokens: 1024,
        system: 'You are AIOS, a helpful multi-model AI assistant. Reply in the same language the user uses (Hinglish if they write Hinglish). Be concise and useful.',
        messages: messages,
      }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message || 'AI error');
    reply = (data.content || []).map(c => c.text || '').join('');
    tokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
  } catch (e) {
    return res.status(503).json({ error: 'ai_failed', detail: e.message }); // no charge on failure
  }
  const latency = Date.now() - t0;

  // 3. settle: deduct actual credits (based on real tokens)
  const credits = Math.max(1, Math.round(cfg.px * (0.5 + tokens / 1500)));
  const newBal = wallet.balance_credits - credits;
  await supabase.from('wallets').update({ balance_credits: newBal, updated_at: new Date() }).eq('user_id', uid);
  await supabase.from('credit_ledger').insert({ user_id: uid, delta: -credits, reason: 'consume', balance_after: newBal });
  await supabase.from('usage_events').insert({
    user_id: uid, model: picked.id, route_reason: picked.why,
    tokens, credits, latency_ms: latency, status: 'ok',
  });

  res.json({ reply, model: picked.id, why: picked.why, credits, latency_ms: latency, balance: newBal });
});

// =====================================================================
// POST /payment/order — Razorpay order banao
// =====================================================================
const PACKS = { // INR paise -> credits
  '49900':  5000,    // ₹499  -> 5,000 credits
  '99900':  12000,   // ₹999  -> 12,000 credits
  '199900': 28000,   // ₹1999 -> 28,000 credits
};
app.post('/payment/order', auth, async (req, res) => {
  const { amount_paise } = req.body;
  const credits = PACKS[String(amount_paise)];
  if (!credits) return res.status(400).json({ error: 'invalid_pack' });

  const order = await razorpay.orders.create({ amount: amount_paise, currency: 'INR', receipt: 'aios_' + Date.now() });
  await supabase.from('transactions').insert({
    user_id: req.user.id, razorpay_order_id: order.id,
    amount_paise, credits_granted: credits, status: 'created',
  });
  res.json({ order_id: order.id, amount: amount_paise, key_id: RAZORPAY_KEY_ID, credits });
});

// =====================================================================
// POST /webhook/razorpay — payment verified -> credits added (SECURE)
// Frontend ke success message pe BHAROSA nahi — sirf is webhook pe.
// =====================================================================
app.post('/webhook/razorpay', async (req, res) => {
  const sig = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(req.body).digest('hex');
  if (sig !== expected) return res.status(403).json({ error: 'bad signature' });

  const evt = JSON.parse(req.body.toString());
  if (evt.event !== 'payment.captured') return res.json({ ok: true });

  const pay = evt.payload.payment.entity;
  // find the transaction by order id
  const { data: txn } = await supabase.from('transactions').select('*').eq('razorpay_order_id', pay.order_id).single();
  if (!txn || txn.status === 'paid') return res.json({ ok: true }); // already done = idempotent

  // mark paid + grant credits (one go)
  await supabase.from('transactions').update({ status: 'paid', razorpay_payment_id: pay.id }).eq('id', txn.id);
  const { data: wallet } = await supabase.from('wallets').select('balance_credits').eq('user_id', txn.user_id).single();
  const newBal = (wallet?.balance_credits ?? 0) + txn.credits_granted;
  await supabase.from('wallets').update({ balance_credits: newBal, updated_at: new Date() }).eq('user_id', txn.user_id);
  await supabase.from('credit_ledger').insert({
    user_id: txn.user_id, delta: txn.credits_granted, reason: 'purchase',
    ref_id: pay.id, balance_after: newBal,
  });
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('AIOS backend live ✅'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('AIOS backend running on', PORT));
