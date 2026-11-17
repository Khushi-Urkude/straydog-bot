const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

const AK = process.env.ADMIN_KEY || 'admin123';
const CK = process.env.CATCHER_KEY || 'catch123';
// Catcher WhatsApp numbers (optional) e.g. CATCHER1_PHONE=whatsapp:+919876543210
const CATCHERS = [
  { id: 1, name: 'Ravi (Zone A)', phone: process.env.CATCHER1_PHONE },
  { id: 2, name: 'Meena (Zone B)', phone: process.env.CATCHER2_PHONE },
  { id: 3, name: 'Imran (Zone C)', phone: process.env.CATCHER3_PHONE },
];
const TYPES = ['Injured', 'Aggressive/Biting', 'Puppies', 'Sick/Roaming'];
const COUNTS = ['1', '2-5', '5+'];
const lbl = s => (s === 'PickedUp' ? 'Picked Up' : s);
const list = a => a.map((x, i) => `${i + 1}. ${x}`).join('\n');
const MENU = '🐾 *StrayDog Helpline*\nReply with a number:\n1. 🐶 Report stray dog\n2. 📋 Check ticket status';

let db = [];
let nid = 1001;
const S = {}; // chat sessions by phone

// Send an outbound WhatsApp message via Twilio (skipped if env vars missing)
async function send(to, body) {
  const { TWILIO_SID: sid, TWILIO_TOKEN: tok, TWILIO_FROM: from } = process.env;
  if (!sid || !tok || !from || !to) return;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }),
    });
  } catch (e) { console.error('send failed', e.message); }
}

function notify(c) {
  const k = CATCHERS.find(x => x.id === c.catcher);
  send(c.phone, `🔔 Ticket #${c.id}: *${lbl(c.status)}*` +
    (k ? `\nCatcher: ${k.name}` : '') + (c.note ? `\nNote: ${c.note}` : ''));
}

function bot(p, t) {
  t = (t || '').trim();
  if (/^(hi|hello|hey|menu|start|0)$/i.test(t)) { S[p] = { step: 'menu', d: {} }; return MENU; }
  const s = S[p] || (S[p] = { step: 'menu', d: {} });
  const reset = () => { S[p] = { step: 'menu', d: {} }; };
  switch (s.step) {
    case 'menu':
      if (t === '1') { s.step = 'loc'; return '📍 Where is the dog? (street / landmark)'; }
      if (t === '2') { s.step = 'track'; return 'Enter your Ticket ID (e.g. 1001):'; }
      return MENU;
    case 'loc':
      s.d.loc = t.slice(0, 200); s.step = 'type';
      return 'What is the problem?\n' + list(TYPES);
    case 'type':
      if (!TYPES[t - 1]) return 'Please reply with a number 1-4.\n' + list(TYPES);
      s.d.type = TYPES[t - 1]; s.step = 'count';
      return 'How many dogs?\n' + list(COUNTS);
    case 'count':
      if (!COUNTS[t - 1]) return 'Please reply with a number 1-3.\n' + list(COUNTS);
      s.d.count = COUNTS[t - 1]; s.step = 'desc';
      return '📝 Add a short description:';
    case 'desc':
      s.d.desc = t.slice(0, 300); s.step = 'ok';
      return `Confirm complaint:\n📍 ${s.d.loc}\n⚠️ ${s.d.type}\n🐕 ${s.d.count}\n📝 ${s.d.desc}\n\n1. ✅ Submit\n2. ❌ Cancel`;
    case 'ok':
      if (t === '1') {
        const c = { id: nid++, phone: p, ...s.d, status: 'New', catcher: null, note: '', at: new Date().toISOString() };
        db.push(c); reset();
        return `✅ Complaint registered!\nTicket ID: *#${c.id}*\nWe'll update you here.\n\nSend "menu" anytime.`;
      }
      reset(); return 'Cancelled.\n\n' + MENU;
    case 'track': {
      const c = db.find(x => x.id == t.replace('#', ''));
      reset();
      const k = c && CATCHERS.find(x => x.id === c.catcher);
      return (c ? `Ticket #${c.id}: *${lbl(c.status)}*${k ? '\nCatcher: ' + k.name : ''}${c.note ? '\nNote: ' + c.note : ''}` : 'Ticket not found.') + '\n\n' + MENU;
    }
  }
  reset(); return MENU;
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Twilio WhatsApp webhook
app.post('/whatsapp', (req, res) => {
  let reply;
  try {
    const b = req.body || {};
    const t = b.Body || (b.Latitude
      ? `${b.Address || 'Pinned location'} (https://maps.google.com/?q=${b.Latitude},${b.Longitude})`
      : '');
    reply = bot(b.From, t);
  } catch (e) { console.error(e); reply = MENU; }
  res.type('text/xml').send(`<Response><Message>${esc(reply)}</Message></Response>`);
});

const auth = k => (q, r, n) => (q.get('x-key') === k ? n() : r.sendStatus(401));

app.get('/api/catchers', (q, r) => r.json(CATCHERS.map(({ id, name }) => ({ id, name }))));
app.get('/api/complaints', auth(AK), (q, r) => r.json([...db].reverse()));
app.get('/api/tasks', auth(CK), (q, r) => r.json(db.filter(c => c.catcher == q.query.catcher).reverse()));

app.post('/api/assign', auth(AK), (q, r) => {
  const c = db.find(x => x.id == q.body.id), k = CATCHERS.find(x => x.id == q.body.catcher);
  if (!c || !k) return r.sendStatus(400);
  c.catcher = k.id; c.status = 'Assigned';
  notify(c);
  send(k.phone, `🐕 New task #${c.id}\n📍 ${c.loc}\n⚠️ ${c.type} · ${c.count}\n📝 ${c.desc}`);
  r.json(c);
});

app.post('/api/status', auth(CK), (q, r) => {
  const c = db.find(x => x.id == q.body.id);
  if (!c || !['Accepted', 'PickedUp', 'Resolved'].includes(q.body.status)) return r.sendStatus(400);
  c.status = q.body.status; c.note = String(q.body.note || '').slice(0, 300);
  notify(c);
  r.json(c);
});

app.listen(process.env.PORT || 3000, () => console.log('StrayDog bot running'));
