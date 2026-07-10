// KTB Brand Kit — Kim the Builder LLC's complete design system, live inside KIT.
// Exposed at GET /api/brand and injected into the KIT Brain so every draft,
// brief, and creative recommendation comes out in Kim's brand.
const BRAND = {
  identity: {
    name: 'Kim the Builder LLC (KTB)',
    principle: 'Elevated professional. Authority meets warmth. Never cold. Never casual.',
    positioning: 'Editorial, premium, money-coded — wealth psychology through clean, light, feminine authority. Kim is the brand; personal authority is the product.',
    signature: 'Hammer 🛠️ — occasional brand mark and closing signature. Never a bullet point, never decoration on every piece.'
  },
  voice: {
    rules: [
      'Confident and direct — Kim speaks as a teacher, not a student.',
      'Warm but elevated. Never cold corporate. Never casual/playful.',
      'First person ("I").',
      'Short, punchy headlines: 3–6 words, curiosity or bold claim.',
      'No filler — every word earns its place.',
      'Outcome-driven copy — transformation, not features.',
      'Language rule: "fundable/funding," never "credit repair."'
    ],
    banned: ["we're still rockin'", 'building like a boss', 'bank moving forward', 'Credit Cousin', 'your biggest cheerleader', 'corny phrasing generally'],
    preferred: ["Let's get this money", "You ain't got no business credit"],
    casing: { headlines: 'Title Case or ALL CAPS — never sentence case on hero text', subheads: 'Title Case', body: 'Sentence case, clean punctuation', ctas: 'Short imperatives: "Get Access." "Start Here." "Join Now."' },
    platforms: {
      instagram: 'Hook in 3–6 words, one idea per slide, CTA on final slide. Keep key content out of bottom 20%.',
      youtube: 'Curiosity-gap titles — incomplete thought that demands the click.',
      email: 'Simple headers; content is the star. Always branded HTML, never plain text.',
      sales_pages: 'Outcome headline + Kim’s image + gold CTA. Never generic.'
    }
  },
  colors: {
    primary: { cream_base: '#F7F4EF', deep_green: '#06392F', husk_gold: '#B7A25E' },
    secondary: {
      mocha_cream: ['#EFE1D2', '#BFA58D', '#7A5C46'],
      greige_glow: ['#F5F2EC', '#D6D0C6', '#9E978C'],
      rose_gold_whisper: ['#E6CFC3', '#C9A99A', '#9C7A6B'],
      blush_silk: ['#F4E6E2', '#D9B8AE', '#A97C73']
    },
    accents: {
      metallic_teal: ['#346D64', '#87DAC6', '#B4FFEC'],
      forest_shadow: ['#1E2F28', '#4F7C6C'],
      burgundy: '#672A19 — controlled micro-accent ONLY: shadows, outlines, depth detail. Never dominant.'
    },
    gradients: {
      mocha: '#EFE1D2 → #BFA58D',
      rose_gold: '#E6CFC3 → #C9A99A → #9C7A6B',
      blush: '#F4E6E2 → #D9B8AE → #A97C73',
      greige: '#F5F2EC → #D6D0C6 → #9E978C',
      teal_accent: '#346D64 → #87DAC6',
      cream_fade: '#F7F4EF → #EFE1D2 (hero fade)'
    },
    hierarchy: ['Cream/light neutral base', 'Deep Green primary text', 'Gold accent', 'Soft gradients for depth', 'Burgundy minimal detail only'],
    gradient_rule: 'Soft, blended, luxury — bottom fade, side panel, highlight block, soft overlay. Never full heavy backgrounds.'
  },
  typography: {
    display: "Playfair Display (serif), fallback Georgia — bold, big, confident, never decorative. Deep Green default.",
    editorial_accent: 'Cormorant Garamond, fallback Georgia',
    body: "DM Sans, fallback Helvetica Neue — light/regular weight, never competes with the headline",
    accent_text: 'Gold #B7A25E or Burgundy #672A19 — sparingly, not on every line'
  },
  layout: [
    'One focal point per design.',
    'Hierarchy: Headline > Subhead > Body > CTA — never equal weight.',
    'White/cream space is intentional — premium, not incomplete.',
    'Left-aligned for editorial; centered for hero/cover moments.',
    'Generous margins, editorial rhythm.'
  ],
  components: 'Thin 1px gold or green borders or none. Rounded corners 4–8px or none — editorial, not bubbly. Barely-there shadows, never dramatic.',
  motion: 'Slow elegant fades, 300–500ms ease-in-out. No bouncy/springy animations. Hover: subtle opacity shift or gold underline reveal.',
  imagery: 'Warm-toned editorial grade. Kim’s face = trust/authority signal — on authority content, not everywhere. Never generic stock. Grain/texture warmth over cold digital.',
  css_tokens: ":root { --color-green:#06392F; --color-gold:#B7A25E; --color-cream:#F7F4EF; --color-burgundy:#672A19; --font-display:'Playfair Display', Georgia, serif; --font-editorial:'Cormorant Garamond', Georgia, serif; --font-sans:'DM Sans', 'Helvetica Neue', sans-serif; }",
  fonts_import: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300..700;1,9..40,300..700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap",
  checklist: [
    'Background is Cream #F7F4EF or approved gradient — not white, not black',
    'Headlines in Deep Green #06392F, Playfair Display',
    'Gold #B7A25E for accents, CTAs, dividers — not as fill',
    'Burgundy only as micro-accent if at all',
    'Body in DM Sans, light/regular',
    'Hammer 🛠️ as signature mark only',
    'Copy punchy, outcome-driven, no filler',
    'One clear focal point, generous cream space',
    'No loud shadows, no bouncy elements, no generic stock'
  ]
};

// Compact prompt block for the KIT Brain — the whole system in ~40 lines.
function promptBlock() {
  return [
    'KTB BRAND KIT (apply to ALL creative output — copy, briefs, pages, emails, scripts):',
    'Principle: ' + BRAND.identity.principle + ' ' + BRAND.identity.positioning,
    'Voice: ' + BRAND.voice.rules.join(' '),
    'Never say: ' + BRAND.voice.banned.join('; ') + '. Preferred phrases: ' + BRAND.voice.preferred.join('; ') + '.',
    'Casing — headlines: ' + BRAND.voice.casing.headlines + '; CTAs: ' + BRAND.voice.casing.ctas,
    'Colors — Cream base #F7F4EF, Deep Green text #06392F, Husk Gold accents #B7A25E; burgundy #672A19 micro-accent only. Secondary palettes: mocha, greige, rose gold, blush. Gradients soft/luxury, never heavy full backgrounds.',
    'Type — Playfair Display headlines (Deep Green), DM Sans body, Cormorant Garamond editorial accent.',
    'Layout — one focal point, clear hierarchy, generous cream space, editorial margins.',
    'Signature — hammer 🛠️ as occasional closing mark, never decoration.',
    'Imagery — warm editorial, never generic stock.',
    'Platforms — IG: 3–6 word hooks, one idea per slide; YouTube: curiosity-gap titles; Email: always branded HTML; Sales pages: outcome headline + gold CTA.'
  ].join('\n');
}

module.exports = { BRAND, promptBlock };
