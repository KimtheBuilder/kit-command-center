// KIT Voice — ElevenLabs text-to-speech proxy. Key stays server-side.
// POST /api/voice/speak { text } -> audio/mpeg stream
// GET  /api/voice/status         -> { enabled, voice_id, model }
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // default ElevenLabs voice; set your own
const EL_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';

function enabled() { return !!EL_KEY; }

function mount(router) {
  router.get('/voice/status', (req, res) => {
    res.json({ ok: true, data: { enabled: enabled(), voice_id: enabled() ? VOICE_ID : null, model: EL_MODEL } });
  });

  router.post('/voice/speak', async (req, res) => {
    if (!enabled()) return res.status(503).json({ ok: false, error: 'Voice not configured. Set ELEVENLABS_API_KEY (and optionally ELEVENLABS_VOICE_ID).' });
    const text = String((req.body && req.body.text) || '').slice(0, 1200);
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + VOICE_ID + '?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: EL_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 }
        })
      });
      if (!r.ok) {
        const err = await r.text().catch(() => '');
        return res.status(502).json({ ok: false, error: 'ElevenLabs error ' + r.status, detail: err.slice(0, 300) });
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    } catch (e) {
      res.status(502).json({ ok: false, error: 'Voice request failed: ' + e.message });
    }
  });
}

module.exports = { mount, enabled };
