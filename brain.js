// KIT Brain — Claude-powered conversational intelligence.
// When ANTHROPIC_API_KEY is set, commands that don't match a structured rule
// are answered by Claude with a live snapshot of the business state.
// Voice-ready output preserved: { answer, detail, recommendation, next_action }.
const store = require('./store');
const rules = require('./rules');
const cc = require('./modules/commandCenter');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

function enabled() { return !!API_KEY; }

function snapshot() {
  const s = cc.summary();
  return {
    execution: {
      open_tasks: s.open_tasks, blocked: s.blocked,
      awaiting_approval: s.awaiting_approval, founder_owned_pct: s.founder_owned_pct
    },
    kpi_board: rules.kpiHealthBoard().map(k => ({ metric: k.metric, label: k.label, status: k.status, latest: k.latest, trend: k.trend })),
    hard_truths: rules.hardTruths().map(t => t.truth),
    scale: rules.scaleReadiness(),
    webinar: rules.webinarCadenceRecommendation(),
    top_tasks: store.list('tasks', t => t.status !== 'completed').sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 8).map(t => ({ title: t.title, status: t.status, owner_type: t.owner_type, priority: t.priority })),
    open_findings: store.list('findings', f => f.status !== 'resolved').slice(0, 8).map(f => ({ finding: f.finding, severity: f.severity })),
    goals: store.list('goals').slice(0, 6).map(g => g.title)
  };
}

const SYSTEM = `You are KIT — Kim the Builder's command-center intelligence. JARVIS energy: calm, precise, dry wit allowed, zero fluff, zero flattery. You are an operator, not a cheerleader.

Context: Kim the Builder is a business funding strategist and credit educator (Atlanta). Funnel: Content -> Fundability Lead Magnet -> Email Nurture -> Monthly Masterclass -> Mentorship. Avatar: the Fundable Entrepreneur. Language rule: "fundable/funding," never "credit repair." Decision filter: visibility, recurring revenue, structured access, leverage, sustainability. She converts best when seen live in authority.

You receive a live JSON snapshot of her business state. Answer from the data. If the data is missing, say so plainly — never invent numbers. Be direct about problems.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{"answer": "one or two spoken-length sentences", "detail": "supporting specifics or null", "recommendation": "the move to make or null", "next_action": "one concrete next step or null"}`;

async function ask(text, actor) {
  if (!enabled()) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: 'Live business snapshot:\n' + JSON.stringify(snapshot()) + '\n\nKim says: "' + String(text).slice(0, 500) + '"'
        }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.answer) return null;
    return {
      answer: parsed.answer,
      detail: parsed.detail || null,
      recommendation: parsed.recommendation || null,
      next_action: parsed.next_action || null,
      data: { source: 'kit_brain', model: MODEL }
    };
  } catch (e) {
    return null; // graceful degradation — router falls back to rule behavior
  }
}

module.exports = { enabled, ask, snapshot };
