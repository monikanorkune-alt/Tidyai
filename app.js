// TidyAI — Laundry Hacks app logic
// Storage keys
const LS = {
  key: 'tidyai_openai_key',
  model: 'tidyai_model',
  stainHistory: 'tidyai_stain_history',
  lastStainScan: 'tidyai_last_stain_scan',
  stainFeedback: 'tidyai_stain_feedback',
  prefs: 'tidyai_prefs',
  recentStains: 'tidyai_recent_stains',
};

// --- State ---
const state = {
  // Laundry state
  stainImageDataUrl: null,
  stainScan: load(LS.lastStainScan, null),
  stainTreatment: null,       // current treatment record from playbook
  stainStepIndex: 0,
  stainSurface: null,
  surfaceFromAI: null,
  stainHistory: load(LS.stainHistory, []),
  prefs: load(LS.prefs, {}),  // sensitive_skin, eco_only, has_pet, hard_water, baby_household, fragrance_free, has_white_hack, has_oxiclean
};

// V3 playbook (50 stains × 8 surfaces, rich schema). Authoritative when matched.
let PLAYBOOK_V3 = null;
function loadPlaybookV3() {
  if (PLAYBOOK_V3) return Promise.resolve(PLAYBOOK_V3);
  return fetch('laundry_playbook_v3.json')
    .then(r => r.ok ? r.json() : null)
    .then(d => { PLAYBOOK_V3 = d; populateStainDatalist(); return d; })
    .catch(err => { console.warn('V3 playbook load failed (falling back to legacy)', err); return null; });
}

// Legacy 802-stain playbook — long-tail fallback for stains V3 doesn't cover.
let PLAYBOOK = null;
function loadPlaybook() {
  if (PLAYBOOK) return Promise.resolve(PLAYBOOK);
  return fetch('laundry_playbook.json')
    .then(r => r.json())
    .then(d => { PLAYBOOK = d; populateStainDatalist(); return d; })
    .catch(err => { console.error('Legacy playbook load failed', err); return null; });
}

// If-then product recommendation rules (loaded lazily, optional).
let RULES = null;
function loadRules() {
  if (RULES) return Promise.resolve(RULES);
  return fetch('product_ifthen_rules.json')
    .then(r => r.ok ? r.json() : null)
    .then(d => { RULES = d; return d; })
    .catch(err => { console.warn('Product rules load failed (using playbook fallback)', err); return null; });
}

// 107-product catalog used by the Hacks tab's "Suggested products" block.
let PRODUCTS_DB = null;
function loadProductsDb() {
  if (PRODUCTS_DB) return Promise.resolve(PRODUCTS_DB);
  return fetch('products_database.json')
    .then(r => {
      if (!r.ok) {
        console.error(`[TidyAI] products_database.json fetch failed: HTTP ${r.status} at ${r.url}. Make sure the file is deployed to GitHub Pages. Falling back to static HACK_RECIPES.`);
        return null;
      }
      return r.json();
    })
    .then(d => {
      if (d && Array.isArray(d.products)) {
        PRODUCTS_DB = d;
        console.info(`[TidyAI] products_database.json loaded · ${d.products.length} products`);
      } else if (d !== null) {
        console.error('[TidyAI] products_database.json returned non-JSON or missing .products — falling back.');
      }
      return PRODUCTS_DB;
    })
    .catch(err => {
      console.error('[TidyAI] products_database.json load error (fetch threw):', err);
      return null;
    });
}

// Boot helper — call all loaders in parallel and resolve when done.
function loadAllPlaybooks() {
  return Promise.all([loadPlaybookV3(), loadPlaybook(), loadRules(), loadProductsDb()]);
}

// =====================================================================
// 2-TAP STAIN PICKER
// 8 fixed groups → flat list of stains in each group → tap → same
// treatment renderer as the AI flow (no separate code path).
// =====================================================================

const STAIN_GROUPS = [
  { id: 'drinks',    label: 'Drinks',          color: '#993556', examples: 'Wine, coffee, tea',
    stains: ['Red wine','Coffee','Tea','Berry juice'] },
  { id: 'food',      label: 'Food & sauces',   color: '#BA7517', examples: 'Ketchup, egg, chocolate',
    stains: ['Tomato sauce','Ketchup','BBQ sauce','Mustard','Soy sauce','Hot sauce / sriracha','Curry / turmeric','Red beet','Pesto','Honey / syrup','Jam / jelly','Chocolate','Egg','Baby formula','Avocado / guacamole','Chewing gum'] },
  { id: 'oils',      label: 'Oils & fats',     color: '#EF9F27', examples: 'Butter, olive oil, ghee',
    stains: ['Butter / ghee','Olive oil','Cooking spray'] },
  { id: 'body',      label: 'Body fluids',     color: '#A32D2D', examples: 'Blood, sweat, vomit',
    stains: ['Blood','Sweat','Vomit'] },
  { id: 'cosmetics', label: 'Personal care',   color: '#D4537E', examples: 'Lipstick, deodorant',
    stains: ['Lipstick','Foundation','Hair dye','Nail polish','Deodorant','Sunscreen','Toothpaste'] },
  { id: 'outdoors',  label: 'Outdoors',        color: '#639922', examples: 'Grass, mud, tree sap',
    stains: ['Grass','Mud','Pollen','Tree sap'] },
  { id: 'kids',      label: 'Kids & pets',     color: '#7F77DD', examples: 'Crayon, marker, pet',
    stains: ['Crayon','Play-Doh / slime','Permanent marker','Ballpoint ink','Pet urine'] },
  { id: 'house',     label: 'Household & DIY', color: '#5F5E5A', examples: 'Rust, wax, paint, glue',
    stains: ['Rust','Mold / mildew','Candle wax','Charcoal / ash','Shoe polish','Latex paint','Oil paint','Super glue'] },
];

// Known brand prefixes used to infer brand from static product names
// (HACK_RECIPES entries have only {name, note}, not a brand field).
const KNOWN_BRANDS = [
  'White Hack','Persil','OxiClean','Tide','Carbona','Dawn','Lestoil','Krud Kutter',
  'Wine Away','The Laundress','Whink','Iron Out','CLR','Rocco & Roxie',"Nature's Miracle",
  'Goo Gone','Earth Breeze','Tru Earth','Kind Laundry','Folex','HEX Performance',
  'WIN','Affresh','OdorKlenz','All','Seventh Generation','Method',"Mrs. Meyer's",
  'ECOS','Branch Basics','Babyganics','Dreft','Cheer','Biz','Anti-Icky-Poo',
  'Spartan','Amodex','Ivory','Fels-Naptha','Zout','Vanish','Sard','The Pink Stuff',
  'Bar Keepers Friend','Arm & Hammer','20 Mule Team','Calgon','Rockin’ Green',
  "Charlie's Soap","Skout's Honor","Mister Max",
];
function brandOf(name) {
  if (!name) return '';
  for (const b of KNOWN_BRANDS) {
    if (name.toLowerCase().startsWith(b.toLowerCase())) return b;
  }
  // Fallback: first significant token
  return name.split(/[\s·]+/)[0];
}

// Product IDs / names that should never appear in any "Suggested products"
// list because they aren't suitable for fabric use.
const HIDE_PRODUCT_IDS = new Set(['pink-stuff-paste']);
const HIDE_PRODUCT_NAMES = ['Pink Stuff Miracle Cleaning Paste', 'Miracle Cleaning Paste'];
function isHiddenProduct(p) {
  if (!p) return false;
  if (p.id && HIDE_PRODUCT_IDS.has(p.id)) return true;
  const n = (p.name || '').toLowerCase();
  return HIDE_PRODUCT_NAMES.some(h => n.includes(h.toLowerCase()));
}

// Keep only one product per brand in the order given.
function dedupeByBrand(products) {
  const seen = new Set();
  const out = [];
  for (const p of products || []) {
    if (isHiddenProduct(p)) continue;
    const brand = ((p.brand || brandOf(p.name)) || '').toLowerCase();
    if (!brand) continue;
    if (seen.has(brand)) continue;
    seen.add(brand);
    out.push(p);
  }
  return out;
}

// =====================================================================
// HACK_RECIPES — chemistry_class → { ingredients, temperature, products }
// Used by the Hacks tab's 3-block detail view. Pure data, no AI.
// =====================================================================
const HACK_RECIPES = {
  protein_based: {
    ingredients: ['Protease enzyme', 'Hydrogen peroxide 3% (whites only)', 'Surfactant (Dawn dish soap)', 'Sodium percarbonate (OxiClean)'],
    temperature: 'Cold water only — hot water cooks protein into fibers permanently.',
    products: [
      { name: 'Persil ProClean Original Liquid', note: '5 enzymes incl. protease' },
      { name: 'OxiClean MaxForce Spray', note: 'Enzyme + surfactant pre-treater' },
      { name: 'White Hack Laundry Detergent Sheets', note: 'Enzyme-powered sheet — targets sweat, grease, odors. Plastic-free, HE-compatible.' },
      { name: 'OxiClean Versatile Powder', note: 'Oxygen booster for the wash' },
      { name: 'Carbona Stain Devils #4', note: 'Blood, dairy, ice cream, glue' },
      { name: 'Tide Free & Gentle', note: 'Sensitive-skin enzyme detergent' },
      { name: 'Dawn Ultra Blue dish soap', note: 'Pre-treat for stubborn protein-on-cotton' },
    ],
  },
  pet_related: {
    ingredients: ['Uricase enzyme (pet-specific)', 'Plant-derived enzymes', 'Surfactant'],
    temperature: 'Cool to lukewarm — NEVER steam (heat sets uric acid permanently).',
    products: [
      { name: 'Rocco & Roxie Stain & Odor Eliminator', note: 'Top-rated pet enzyme cleaner' },
      { name: "Nature's Miracle Advanced", note: 'Cult favorite for pet urine' },
      { name: 'Anti-Icky-Poo (Mister Max)', note: 'For intact tomcat spray' },
      { name: "Skout's Honor Stain & Odor Solution", note: 'Plant-derived enzymes' },
      { name: 'Folex Carpet Cleaner', note: 'Carpet-specific after enzyme soak' },
    ],
  },
  food_grease_or_body_oil: {
    ingredients: ['Lipase enzyme', 'Surfactant (Dawn)', 'Absorbent powder (cornstarch, baking soda)', 'Solvent for set stains (alcohol, mineral spirits)'],
    temperature: 'Warm to hot — heat helps the oil release from fibers.',
    products: [
      { name: 'Dawn Ultra Blue dish soap', note: 'Universal grease cutter (~$3)' },
      { name: 'Persil ProClean Powder', note: 'Has lipase enzyme' },
      { name: 'White Hack Laundry Detergent Sheets', note: 'Enzyme-powered sheet — targets sweat, grease, odors. Plastic-free, HE-compatible.' },
      { name: 'Tide Original Powder', note: 'Lipase-rich workhorse' },
      { name: 'Lestoil', note: 'Heavy/industrial grease' },
      { name: 'Krud Kutter Original Cleaner/Degreaser', note: 'Mechanic / kitchen grease' },
      { name: 'OxiClean MaxForce Spray', note: 'Multi-enzyme pre-treater' },
      { name: 'Cornstarch or baking soda', note: 'Absorbent — apply BEFORE wash' },
    ],
  },
  tannin_based: {
    ingredients: ['Sodium percarbonate (oxygen bleach)', 'Mild acid (white vinegar)', 'Surfactant (Dawn)', 'Hydrogen peroxide 3% (whites)'],
    temperature: 'Cold rinse first, then warm wash. Hot water on a fresh tannin stain sets it permanently.',
    products: [
      { name: 'OxiClean Versatile Powder', note: 'Overnight soak for set stains' },
      { name: 'Wine Away', note: 'Purpose-built for wine (~$8)' },
      { name: 'White Hack Laundry Detergent Sheets', note: 'Enzyme-powered sheet — targets sweat, grease, odors. Plastic-free, HE-compatible.' },
      { name: 'Carbona Stain Devils #8', note: 'Coffee/tea/wine/juice specialist' },
      { name: 'The Laundress Wine & Coffee Stain Bar', note: 'Gentle for silk (~$16)' },
      { name: 'Persil ProClean liquid', note: 'Multi-enzyme detergent' },
      { name: 'Dawn + 3% hydrogen peroxide paste', note: 'DIY — whites only' },
    ],
  },
  dye_based: {
    ingredients: ['Isopropyl alcohol 91%', 'Surfactant (Dawn)', 'Sodium percarbonate (OxiClean)', 'Specialty dye-lift (Amodex)'],
    temperature: 'Cool to lukewarm — hot water sets dye permanently.',
    products: [
      { name: 'Amodex Ink & Stain Remover', note: 'Gentler than alcohol, more fabric-safe' },
      { name: '91% Isopropyl rubbing alcohol', note: 'Cheap drugstore staple' },
      { name: 'OxiClean Versatile Powder', note: 'Overnight soak for set color' },
      { name: 'Dawn Ultra Blue', note: 'After alcohol, removes dye carrier' },
      { name: 'Carbona Color Run Remover', note: 'For bleed accidents' },
      { name: 'Old-formula hairspray', note: 'High-alcohol — works on Sharpie' },
    ],
  },
  mineral_based: {
    ingredients: ['Oxalic acid (Whink)', 'Citric acid (lemon juice)', 'UV / direct sunlight'],
    temperature: 'Cool water — never hot (sets rust permanently).',
    products: [
      { name: 'Whink Rust Stain Remover', note: 'Heavy-duty (hydrofluoric acid — wear gloves)' },
      { name: 'Whink Color-Safe Iron Out', note: 'Gentler color-safe version' },
      { name: 'Iron Out spray gel', note: 'Bathroom + fabric + carpet' },
      { name: 'CLR Calcium Lime Rust', note: 'Test fabric first' },
      { name: 'Lemon juice + salt + sunlight', note: 'DIY — 1-2 hours in direct sun' },
    ],
  },
  mold_or_mildew: {
    ingredients: ['Acetic acid (white vinegar)', 'Sodium percarbonate (oxygen bleach)', 'Enzyme detergent', 'UV / sunlight'],
    temperature: 'Hot wash kills spores. Sun-dry to prevent regrowth.',
    products: [
      { name: 'White vinegar', note: '1 cup pre-soak for an hour' },
      { name: 'OxiClean Tough Stain Remover', note: 'Oxygen bleach soak' },
      { name: 'Persil ProClean', note: 'Hot wash with enzyme detergent' },
      { name: 'OdorKlenz Laundry Additive', note: 'Mineral-based, fragrance-free' },
      { name: 'HEX Performance', note: 'Athletic-wear specific musty' },
      { name: 'Affresh Washing Machine Cleaner', note: 'Treat the machine itself' },
    ],
  },
  sweat_aluminum_yellow_pit: {
    ingredients: ['Oxalic acid (Iron Out)', 'Sodium percarbonate (OxiClean)', 'Lipase enzyme', 'Surfactant (Dawn)', 'UV / sunlight'],
    temperature: 'Hot soak — heat dissolves aluminum-protein bonds.',
    products: [
      { name: 'Whink Color-Safe Iron Out', note: 'Dissolves the aluminum component' },
      { name: 'OxiClean Versatile Powder', note: 'Overnight hot soak' },
      { name: 'White Hack Laundry Detergent Sheets', note: 'Enzyme-powered sheet — targets sweat, grease, odors. Plastic-free, HE-compatible.' },
      { name: 'Dawn Ultra Blue', note: 'Pre-treat for the sebum layer' },
      { name: 'Persil ProClean Powder', note: 'Lipase-rich hot wash' },
      { name: 'Carbona Stain Devils #1', note: 'Cosmetics + deodorant specialist' },
    ],
  },
  sugar_or_sticky: {
    ingredients: ['Cold (ice)', 'Surfactant (Dawn)', 'Solvent (91% alcohol)', 'Citrus oil (Goo Gone)'],
    temperature: 'Cold first for physical removal, then warm wash for sugar residue.',
    products: [
      { name: 'Ice', note: 'Hardens gum / sap for scraping' },
      { name: '91% Isopropyl rubbing alcohol', note: 'Dissolves polymer residue' },
      { name: 'Goo Gone Citrus Cleaner', note: 'Tape glue, sticker residue' },
      { name: 'Dawn Ultra Blue', note: 'After scraping, cuts oil component' },
      { name: 'Persil ProClean', note: 'Final wash' },
      { name: 'White vinegar', note: 'Soak for slime polymer' },
    ],
  },
  wax_based: {
    ingredients: ['Heat (warm iron)', 'Absorbent (brown paper bag)', 'Surfactant (Dawn)'],
    temperature: 'Warm iron through paper for melt-and-absorb; final wash warm.',
    products: [
      { name: 'Brown paper bag + warm iron', note: 'The core technique' },
      { name: 'Dawn Ultra Blue', note: 'Removes residual oil ring' },
      { name: 'Persil ProClean', note: 'Final warm wash' },
      { name: 'Goo Gone', note: 'For stubborn rings' },
      { name: 'Lestoil', note: 'Crayon-in-dryer disasters' },
    ],
  },
  iodine_or_betadine: {
    ingredients: ['Ascorbic acid (Vitamin C)', 'Sodium thiosulfate', 'Hydrogen peroxide 3% (whites only)'],
    temperature: 'Cool water from the back. NEVER chlorine bleach — creates a permanent brown mark.',
    products: [
      { name: 'Vitamin C tablets', note: '2 × 500mg crushed in 1/2 cup warm water' },
      { name: 'Sodium thiosulfate', note: '1 tbsp in 1 cup water — lab-grade' },
      { name: 'Betadine Stain Remover (Bruce Medical)', note: 'Purpose-built' },
      { name: 'Spartan Clothesline Fresh S5', note: 'Commercial iodine/betadine remover' },
      { name: 'Hydrogen peroxide 3%', note: 'Whites only — never with bleach' },
    ],
  },
  tannin_and_oil_combo: {
    ingredients: ['Dawn (oil first)', 'Oxygen bleach (color second)', 'Lipase + protease enzymes'],
    temperature: 'Cold rinse from back, then warm wash. Hot first sets the protein/tannin.',
    products: [
      { name: 'Dawn Ultra Blue', note: 'Step 1 — oil layer' },
      { name: 'OxiClean Versatile Powder', note: 'Step 2 — color/tannin layer' },
      { name: 'Persil ProClean', note: 'Multi-enzyme wash' },
      { name: 'OxiClean MaxForce Spray', note: 'Single-step pre-treater' },
      { name: 'Lestoil', note: 'For heavy oily sauces like BBQ' },
    ],
  },
};

const HACK_DEFAULT = {
  ingredients: ['Surfactant (Dawn)', 'Sodium percarbonate (OxiClean)', 'Cool water'],
  temperature: 'Start cool — escalate to warm only if needed.',
  products: [
    { name: 'Dawn Ultra Blue dish soap', note: 'Universal pre-treater' },
    { name: 'OxiClean Versatile Powder', note: 'Oxygen booster' },
    { name: 'White Hack Laundry Detergent Sheets', note: 'Enzyme-powered sheet — targets sweat, grease, odors. Plastic-free, HE-compatible.' },
    { name: 'Persil ProClean', note: 'Multi-enzyme detergent' },
    { name: 'Tide Free & Gentle', note: 'Sensitive-skin alternative' },
    { name: 'White vinegar', note: 'For mineral or musty issues' },
  ],
};

// Maps V3's combo / specialty chemistry classes to the closest primary class
// that HACK_RECIPES and the products database actually cover. Without these
// aliases, half the V3 stains land in HACK_DEFAULT because HACK_RECIPES has
// no entry for "tannin_and_oil_combo", "particulate", "wax_and_dye_combo", etc.
const CHEMISTRY_CLASS_ALIAS = {
  tannin_and_oil_combo:   'tannin_based',
  tannin_and_sugar_combo: 'tannin_based',
  wax_and_dye_combo:      'wax_based',
  particulate:            'food_grease_or_body_oil',
  particulate_with_tannin: 'tannin_based',
  particulate_with_oil:    'food_grease_or_body_oil',
  water_soluble_polymer:   'dye_based',
  polymer_cured:           'food_grease_or_body_oil',
  oil_polymer:             'food_grease_or_body_oil',
};
function canonChem(c) { return (c && CHEMISTRY_CLASS_ALIAS[c]) || c; }

// Picks a canonical chemistry class for any stain, regardless of source:
//   1. stain.chemistry_class (V3) — canonicalized via alias map
//   2. inferred from name + treatment_summary keywords (legacy fallback)
//   3. 'general_purpose' (final fallback)
function resolveChemistryClass(stain) {
  if (!stain) return 'general_purpose';
  const direct = canonChem(stain.chemistry_class);
  if (direct) return direct;
  // Legacy stains: scan name + treatment_summary against RULES.stain_chemistry keywords
  if (typeof stainChemistryClass === 'function') {
    const inferred = stainChemistryClass(stain);
    if (inferred) return canonChem(inferred);
  }
  return 'general_purpose';
}

function getHackRecipe(stain) {
  const cls = resolveChemistryClass(stain);
  return HACK_RECIPES[cls] || HACK_DEFAULT;
}

// Extract a "For Whites" callout from a stain's prose if one exists.
// V3 stains store these inside alt_method / science / pro_tip; legacy stains
// store them inside treatment_summary. Returns the matching sentence or null.
function getForWhitesNote(stain) {
  if (!stain) return null;
  const sources = [
    stain.pro_tip, stain.alt_method, stain.expectation,
    stain.science, stain.treatment_summary, stain.never_do,
  ];
  for (const src of sources) {
    if (!src || typeof src !== 'string') continue;
    // Split on sentence boundaries (period/exclamation/question + space + capital)
    const sentences = src.split(/(?<=[.!?])\s+(?=[A-Z])/);
    for (const sent of sentences) {
      const lower = sent.toLowerCase();
      if (/\bwhites only\b|\bon whites\b|\bfor whites\b|\bfor white (cotton|fabric|linen|t-shirt|shirt)/.test(lower)) {
        return sent.trim();
      }
    }
  }
  return null;
}

// Place White Hack in position 3 whenever its active ingredients align with
// what this stain needs. Implementation: look up the best-fit White Hack SKU
// from PRODUCTS_DB (one whose best_for includes the stain's chemistry_class)
// and inject it at index 2 — moving it from its current spot if it's already
// there, or replacing the picked product at index 2 if not.
//
// Respects pref-driven hard-exclusions: if the user has sensitive_skin /
// fragrance_free / eco_only and the WH SKU doesn't carry the required tag,
// we don't inject it.
function promoteWhiteHack(picks, stain, prefs) {
  if (!Array.isArray(picks)) return picks;
  if (!PRODUCTS_DB) return picks;
  const chem = resolveChemistryClass(stain);
  const userPrefs = prefs || (state && state.prefs) || {};

  // All White Hack SKUs whose chemistry-fit matches this stain.
  const candidates = PRODUCTS_DB.products.filter(p =>
    (p.brand || '').toLowerCase() === 'white hack' &&
    (p.best_for || []).includes(chem)
  );
  if (!candidates.length) return picks;

  // Respect hard-exclusion prefs — pick the first WH SKU that survives.
  const fragfree = userPrefs.sensitive_skin || userPrefs.baby_household || userPrefs.fragrance_free;
  const passesPrefs = p => {
    const tags = p.tags || [];
    if (fragfree && !tags.includes('fragrance_free') && !tags.includes('sensitive_skin')) return false;
    if (userPrefs.eco_only && !tags.includes('eco') && !tags.includes('plant_based')) return false;
    return true;
  };
  const wh = candidates.find(passesPrefs);
  if (!wh) return picks;

  // Remove any existing WH entries (avoid duplicates), then inject at index 2.
  const cleaned = picks.filter(p => (p.brand || '').toLowerCase() !== 'white hack');
  // If fewer than 3 items exist, append; otherwise insert at index 2.
  if (cleaned.length < 2) {
    cleaned.push(wh);
  } else {
    cleaned.splice(2, 0, wh);
  }
  return cleaned.slice(0, 10);
}

// =====================================================================
// pickProductsForStain — DB-driven picker for the Hacks tab's
// "Suggested products" block. Scores and ranks the 107-product catalog
// by (a) chemistry-class match, (b) user prefs, (c) popularity.
//
// Hard rules per the spec:
//  - min 5, max 10 products returned
//  - sensitive_skin / baby_household HARD-EXCLUDES non fragrance-free SKUs
//  - eco_only HARD-EXCLUDES non eco / non plant-based SKUs
//  - pet boost only fires when chemistry_class === 'pet_related'
//  - fallback to general_purpose products when the stain has no chemistry_class
//  - never returns a product not in PRODUCTS_DB.products
// =====================================================================
function pickProductsForStain(stain, userPrefs) {
  if (!PRODUCTS_DB || !Array.isArray(PRODUCTS_DB.products)) return null;
  const prefs = userPrefs || state.prefs || {};
  // resolveChemistryClass handles missing chem (legacy) + combo aliasing (V3).
  const chemClass = resolveChemistryClass(stain);

  const isExcluded = (p) => {
    const tags = p.tags || [];
    if (prefs.sensitive_skin || prefs.baby_household) {
      if (!tags.includes('fragrance_free') && !tags.includes('sensitive_skin')) return true;
    }
    if (prefs.eco_only) {
      if (!tags.includes('eco') && !tags.includes('plant_based')) return true;
    }
    if (prefs.fragrance_free) {
      if (!tags.includes('fragrance_free') && !tags.includes('sensitive_skin')) return true;
    }
    return false;
  };

  const score = (p) => {
    let s = 0;
    const tags = p.tags || [];
    const bestFor = p.best_for || [];
    // Big bonus for matching the stain's chemistry class
    if (bestFor.includes(chemClass)) s += 100;
    // Smaller bonus for general_purpose (always relevant as a backup pick)
    if (bestFor.includes('general_purpose')) s += 20;
    // Popular brands get a baseline boost
    if (tags.includes('popular')) s += 30;
    if (tags.includes('cult_favorite')) s += 25;
    // Preference-driven boosts
    if (prefs.sensitive_skin && tags.includes('sensitive_skin')) s += 40;
    if (prefs.baby_household && tags.includes('baby')) s += 40;
    if (prefs.fragrance_free && tags.includes('fragrance_free')) s += 35;
    if (prefs.eco_only && tags.includes('eco')) s += 35;
    if (prefs.has_pet && tags.includes('pet') && chemClass === 'pet_related') s += 50;
    if (prefs.hard_water && tags.includes('hard_water')) s += 35;
    // "On hand" boosts — only fire when chemistry class matches
    const chemMatches = bestFor.includes(chemClass);
    if (prefs.has_white_hack && p.brand === 'White Hack' && chemMatches) s += 60;
    if (prefs.has_oxiclean && p.brand === 'OxiClean' && chemMatches) s += 30;
    if (prefs.has_dawn && p.id === 'dawn-blue' && chemMatches) s += 30;
    if (prefs.has_persil && p.brand === 'Persil' && chemMatches) s += 30;
    if (prefs.has_tide_powder && p.id === 'tide-original-powder' && chemMatches) s += 30;
    return s;
  };

  const ranked = PRODUCTS_DB.products
    .filter(p => !isExcluded(p))
    .map(p => ({ p, s: score(p) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const top = ranked.slice(0, 10).map(x => x.p);

  // Pad to minimum 5 with popular general-purpose products that aren't excluded.
  if (top.length < 5) {
    const fillers = PRODUCTS_DB.products
      .filter(p => !top.includes(p) && !isExcluded(p))
      .filter(p => (p.best_for || []).includes('general_purpose') && (p.tags || []).includes('popular'));
    for (const f of fillers) {
      top.push(f);
      if (top.length >= 5) break;
    }
  }

  return top.slice(0, 10);
}

// =====================================================================
// HACKS TAB — browse-only category → list → 3-block detail → search
// Never calls the AI vision API.
// =====================================================================
let HACKS_CURRENT_GROUP = null;

// Filter-chip handler on the Hacks tab landing. Tapping a tag (eco, popular,
// fragrance-free, sensitive skin, sheets, baby, athletic) replaces the category
// grid with a flat list of matching products from the database. Tapping "All"
// restores the grid.
function onHacksFilterChip(filterId) {
  document.querySelectorAll('.hacks-filter-chip').forEach(c => {
    c.setAttribute('data-active', c.dataset.filter === filterId ? 'true' : 'false');
  });
  const grid = document.getElementById('hacks-group-grid');
  const wrap = document.getElementById('hacks-filtered-products');
  if (!grid || !wrap) return;
  if (filterId === 'all') {
    grid.style.display = 'grid';
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  grid.style.display = 'none';
  wrap.style.display = 'block';
  if (!PRODUCTS_DB) { wrap.innerHTML = '<p style="color:var(--muted)">Loading products…</p>'; loadProductsDb().then(() => onHacksFilterChip(filterId)); return; }
  let filtered;
  if (filterId === 'sheet') {
    filtered = PRODUCTS_DB.products.filter(p => p.format === 'sheet');
  } else {
    filtered = PRODUCTS_DB.products.filter(p => (p.tags || []).includes(filterId));
  }
  // Hide Pink Stuff + one product per brand
  filtered = dedupeByBrand(filtered).slice(0, 30);
  if (!filtered.length) {
    wrap.innerHTML = `<p style="color:var(--muted)">No products with that tag yet.</p>`;
    return;
  }
  wrap.innerHTML = `
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);margin-bottom:8px">${filtered.length} products</div>
    ${filtered.map(p => `
      <div style="padding:10px 0;border-bottom:0.5px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
          <div><span style="font-weight:600">${escapeHtml(p.brand)}</span><span style="color:var(--muted)"> · ${escapeHtml(p.name)}</span></div>
          <span style="color:var(--muted);font-size:12px;white-space:nowrap">${escapeHtml(p.price || '')}</span>
        </div>
        ${p.description ? `<div style="font-size:12px;color:var(--muted);margin-top:3px;line-height:1.4">${escapeHtml(p.description)}</div>` : ''}
      </div>
    `).join('')}
  `;
}

function renderHacksCategories() {
  const grid = document.getElementById('hacks-group-grid');
  if (!grid) return;
  // Wire chip handlers (idempotent — replaces any existing listener via cloneNode)
  document.querySelectorAll('.hacks-filter-chip').forEach(c => {
    const next = c.cloneNode(true);
    c.parentNode.replaceChild(next, c);
    next.addEventListener('click', () => onHacksFilterChip(next.dataset.filter));
  });
  grid.innerHTML = STAIN_GROUPS.map(g => `
    <button class="cat-btn" data-group="${g.id}" style="text-align:left;display:flex;flex-direction:column;gap:4px;min-height:72px;padding:12px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:10px;height:10px;border-radius:50%;background:${g.color};flex:none"></span>
        <span style="font-size:14px;font-weight:600;color:var(--text)">${escapeHtml(g.label)}</span>
      </div>
      <span style="font-size:11px;color:var(--muted);font-weight:400">${escapeHtml(g.examples)} · ${g.stains.length}</span>
    </button>
  `).join('');
  grid.querySelectorAll('button[data-group]').forEach(btn => {
    btn.addEventListener('click', () => openHacksList(btn.dataset.group));
  });
}

function openHacksList(groupId) {
  const group = STAIN_GROUPS.find(g => g.id === groupId);
  if (!group) return;
  HACKS_CURRENT_GROUP = groupId;
  document.getElementById('hacks-list-title').textContent = group.label;
  const list = document.getElementById('hacks-stain-list');
  const rows = group.stains.map(name => `
    <button class="stain-row" data-stain="${escapeHtml(name)}" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--card-strong);border:1px solid var(--border);border-radius:12px;font-size:14px;color:var(--text);cursor:pointer;min-height:44px;text-align:left;width:100%">
      <span>${escapeHtml(name)}</span>
      <span style="color:var(--muted);font-size:14px">›</span>
    </button>
  `);
  // Always-on "Something else" row at the bottom.
  rows.push(`
    <button class="stain-row" data-stain="__SOMETHING_ELSE__" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--card-strong);border:1px dashed var(--border);border-radius:12px;font-size:14px;color:var(--muted);cursor:pointer;min-height:44px;text-align:left;width:100%">
      <span>🔍 Something else</span>
      <span style="color:var(--muted);font-size:14px">›</span>
    </button>
  `);
  list.innerHTML = rows.join('');
  list.querySelectorAll('button[data-stain]').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.stain;
      if (name === '__SOMETHING_ELSE__') return openHacksSearch();
      openHacksDetail(name);
    });
  });
  document.getElementById('hacks-categories').style.display = 'none';
  document.getElementById('hacks-stain-list-wrap').style.display = 'block';
  document.getElementById('hacks-detail').style.display = 'none';
  document.getElementById('hacks-search').style.display = 'none';
}

function hacksBackToCategories() {
  document.getElementById('hacks-categories').style.display = 'block';
  document.getElementById('hacks-stain-list-wrap').style.display = 'none';
  document.getElementById('hacks-detail').style.display = 'none';
  document.getElementById('hacks-search').style.display = 'none';
}

function hacksBackToList() {
  if (HACKS_CURRENT_GROUP) openHacksList(HACKS_CURRENT_GROUP);
  else hacksBackToCategories();
}

async function openHacksDetail(stainName) {
  await loadAllPlaybooks();
  const stain = findStainInPlaybook(stainName);
  if (!stain) {
    // Show a "not in playbook" message in the search panel
    openHacksSearch();
    document.getElementById('hacks-search-input').value = stainName;
    document.getElementById('hacks-search-result').innerHTML = `<div class="stain-result"><p>I don't have "${escapeHtml(stainName)}" in the playbook yet. Try a more common name (e.g. "wine" instead of "merlot"), or open the Stains tab to identify by photo.</p></div>`;
    return;
  }
  // Stamp the canonical chemistry class so legacy stains (no chem) and V3 combo
  // classes both map to a HACK_RECIPES entry the picker / WH promoter can use.
  stain.chemistry_class = resolveChemistryClass(stain);
  const recipe = getHackRecipe(stain);

  document.getElementById('hacks-detail-title').textContent = stain.name;

  // Block 1 — Hack the stain. If the stain's prose mentions a whites-specific
  // treatment, surface it in a callout row ABOVE the science explanation.
  const aboutText = stain.science
    || stain.treatment_summary
    || `This is a ${(stain.chemistry_class || 'general').replace(/_/g, ' ')} stain. Treat per the active ingredients and products below.`;
  const whitesNote = getForWhitesNote(stain);
  document.getElementById('hacks-detail-about').innerHTML = `
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);margin-bottom:6px">Hack the stain</div>
    ${whitesNote ? `
      <div style="padding:10px 12px;background:rgba(244,244,244,0.06);border:1px solid var(--border);border-radius:10px;margin-bottom:10px;font-size:13px;line-height:1.5">
        <strong style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#FFB906;display:block;margin-bottom:4px">For Whites</strong>
        ${escapeHtml(whitesNote)}
      </div>
    ` : ''}
    <p style="margin:0;line-height:1.5">${escapeHtml(aboutText)}</p>
  `;

  // Block 2 — Active ingredients needed (renamed; same ingredients list + water box)
  document.getElementById('hacks-detail-ingredients').innerHTML = `
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);margin-bottom:6px">Active ingredients needed</div>
    <ul style="margin:0 0 10px;padding-left:18px;line-height:1.6">${recipe.ingredients.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
    <div style="padding:10px;background:rgba(165,222,244,0.10);border:1px solid rgba(165,222,244,0.30);border-radius:10px;font-size:13px;line-height:1.5">
      <strong style="color:#A5DEF4">🌡 Water:</strong> ${escapeHtml(recipe.temperature)}
    </div>
  `;

  // Block 3 — Suggested products. Drop the count from the header. If White
  // Hack is in the picks (ingredient-fit with this chemistry class), promote
  // it to position 3.
  const rawPicks = pickProductsForStain(stain, state.prefs) || [];
  // One product per brand + hide Pink Stuff (not fabric-safe). White Hack
  // promotion runs AFTER dedupe so it still lands at position 3.
  const deduped = dedupeByBrand(rawPicks);
  const picks = promoteWhiteHack(deduped, stain, state.prefs);
  const productsEl = document.getElementById('hacks-detail-products');
  if (picks.length) {
    productsEl.innerHTML = `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);margin-bottom:6px">Suggested products</div>
      ${picks.map(p => `
        <div style="padding:10px 0;border-bottom:0.5px solid var(--border)">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
            <div>
              <span style="font-weight:600">${escapeHtml(p.brand)}</span>
              <span style="color:var(--muted);font-weight:400"> · ${escapeHtml(p.name)}</span>
            </div>
            <span style="color:var(--muted);font-size:12px;white-space:nowrap">${escapeHtml(p.price || '')}</span>
          </div>
          ${p.description ? `<div style="margin-top:4px;font-size:12px;color:var(--muted);line-height:1.4">${escapeHtml(p.description)}</div>` : ''}
          ${(p.tags && p.tags.length) ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${p.tags.slice(0, 4).map(t => `<span style="padding:2px 8px;border-radius:999px;background:var(--card-strong);border:1px solid var(--border);font-size:10px;color:var(--muted)">${escapeHtml(t.replace(/_/g, ' '))}</span>`).join('')}</div>` : ''}
        </div>
      `).join('')}
    `;
  } else {
    // Fallback: HACK_RECIPES static list. Dedupe by brand + hide Pink Stuff.
    const fallback = dedupeByBrand(recipe.products);
    productsEl.innerHTML = `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);margin-bottom:6px">Suggested products</div>
      ${fallback.map(p => `
        <div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:0.5px solid var(--border)">
          <div style="font-weight:600">${escapeHtml(p.name)}</div>
          <div style="color:var(--muted);font-size:12px;text-align:right;max-width:55%">${escapeHtml(p.note || '')}</div>
        </div>
      `).join('')}
    `;
  }

  document.getElementById('hacks-categories').style.display = 'none';
  document.getElementById('hacks-stain-list-wrap').style.display = 'none';
  document.getElementById('hacks-detail').style.display = 'block';
  document.getElementById('hacks-search').style.display = 'none';
}

function openHacksSearch() {
  document.getElementById('hacks-categories').style.display = 'none';
  document.getElementById('hacks-stain-list-wrap').style.display = 'none';
  document.getElementById('hacks-detail').style.display = 'none';
  document.getElementById('hacks-search').style.display = 'block';
  document.getElementById('hacks-search-result').innerHTML = '';
  setTimeout(() => document.getElementById('hacks-search-input')?.focus(), 60);
}

async function hacksSearchSubmit() {
  const q = (document.getElementById('hacks-search-input').value || '').trim();
  if (!q) return;
  await loadAllPlaybooks();
  const stain = findStainInPlaybook(q);
  if (!stain) {
    document.getElementById('hacks-search-result').innerHTML = `
      <div class="stain-result"><p>Sorry, "${escapeHtml(q)}" isn't in our playbook yet. Try a more common name (e.g. "wine" instead of "merlot"), or open the Stains tab to identify by photo.</p></div>
    `;
    return;
  }
  // Hand off to the same detail renderer
  openHacksDetail(stain.name);
}

function renderStainGroupGrid() {
  const grid = document.getElementById('stain-group-grid');
  if (!grid) return;
  grid.innerHTML = STAIN_GROUPS.map(g => `
    <button class="cat-btn" data-group="${g.id}" style="text-align:left;display:flex;flex-direction:column;gap:4px;min-height:72px;padding:12px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:10px;height:10px;border-radius:50%;background:${g.color};flex:none"></span>
        <span style="font-size:14px;font-weight:600;color:var(--text)">${escapeHtml(g.label)}</span>
      </div>
      <span style="font-size:11px;color:var(--muted);font-weight:400">${escapeHtml(g.examples)} · ${g.stains.length}</span>
    </button>
  `).join('');
  grid.querySelectorAll('button[data-group]').forEach(btn => {
    btn.addEventListener('click', () => openGroupStains(btn.dataset.group));
  });
}

function openGroupStains(groupId) {
  const group = STAIN_GROUPS.find(g => g.id === groupId);
  if (!group) return;
  document.getElementById('group-stains-title').textContent = group.label;
  const list = document.getElementById('group-stains-list');
  list.innerHTML = group.stains.map(name => `
    <button class="stain-row" data-stain="${escapeHtml(name)}" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--card-strong);border:1px solid var(--border);border-radius:12px;font-size:14px;color:var(--text);cursor:pointer;min-height:44px;text-align:left;width:100%">
      <span>${escapeHtml(name)}</span>
      <span style="color:var(--muted);font-size:14px">›</span>
    </button>
  `).join('');
  list.querySelectorAll('button[data-stain]').forEach(btn => {
    btn.addEventListener('click', () => pickStainManually(btn.dataset.stain));
  });
  // Hide the hero (the photo CTA + grid) so the user isn't shown two competing screens.
  document.getElementById('laundry-hero').style.display = 'none';
  document.getElementById('stain-group-stains').style.display = 'block';
}

function closeGroupStains() {
  document.getElementById('stain-group-stains').style.display = 'none';
  document.getElementById('laundry-hero').style.display = 'block';
}

// The critical hand-off: a manually-picked stain lands in the same flow as an
// AI-identified stain. Sets state, then calls startTreatment() — the SAME
// function the AI flow uses — which routes to surface picker (V3) or steps (legacy).
async function pickStainManually(stainName) {
  await loadAllPlaybooks();
  const treatment = getStainTreatment(stainName);
  if (!treatment) {
    toast('No playbook entry for ' + stainName);
    return;
  }
  state.stainTreatment = treatment;
  state.currentStain = treatment;  // alias used by spec tests + future code
  state.surfaceFromAI = null;
  state.stainSurface = null;
  // Synthesize a scan so "Back to result" + history paths work uniformly.
  state.stainScan = {
    confident: true, stain_name: treatment.name, category: treatment.category,
    confidence: 1.0, surface_observed: 'unknown',
  };
  save(LS.lastStainScan, state.stainScan);

  // Save to "recently used" (max 3, dedupe by name)
  const recent = load(LS.recentStains, []).filter(r => r !== stainName);
  recent.unshift(stainName);
  save(LS.recentStains, recent.slice(0, 3));
  renderRecentStrip();

  // Hide the picker view + hero before kicking off treatment.
  const groupStains = document.getElementById('stain-group-stains');
  if (groupStains) groupStains.style.display = 'none';
  const hero = document.getElementById('laundry-hero');
  if (hero) hero.style.display = 'block';
  // Land on the rich "Most likely" card first — same as the AI flow. The user
  // sees the photo (if any), about/treatment summary, common mistakes, pro
  // tip, expectation, science, then taps "Start treatment" to proceed.
  renderStainResult(state.stainScan);
  setTimeout(() => document.getElementById('stain-confident')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
}

// Up to 3 most-recently picked stains shown as chips above the group grid.
function renderRecentStrip() {
  const wrap = document.getElementById('stain-recent-wrap');
  const list = document.getElementById('stain-recent-list');
  if (!wrap || !list) return;
  const recent = load(LS.recentStains, []);
  if (!recent.length) { wrap.style.display = 'none'; return; }
  list.innerHTML = recent.slice(0, 3).map(name => `
    <button class="chip" data-stain="${escapeHtml(name)}" style="padding:6px 12px;border-radius:999px;background:var(--card-strong);border:1px solid var(--border);font-size:12px;color:var(--text);cursor:pointer">
      ${escapeHtml(name)}
    </button>
  `).join('');
  list.querySelectorAll('button[data-stain]').forEach(btn => {
    btn.addEventListener('click', () => pickStainManually(btn.dataset.stain));
  });
  wrap.style.display = 'block';
}

// Map a playbook stain to one of the chemistry classes in the rules file.
// Returns the rule's `if` key (e.g. "tannin_based") or null.
function stainChemistryClass(stain) {
  if (!RULES || !stain) return null;
  const haystack = `${(stain.name || '')} ${(stain.treatment_summary || '')}`.toLowerCase();
  let bestClass = null;
  let bestLen = 0;
  for (const rule of (RULES.rules?.stain_chemistry || [])) {
    for (const kw of (rule.match_stains || [])) {
      const k = kw.toLowerCase();
      if (haystack.includes(k) && k.length > bestLen) {
        bestClass = rule.if;
        bestLen = k.length;
      }
    }
  }
  return bestClass;
}

// Map a fabric hint (free text) to a fabric_specific rule key.
function fabricClass(fabricHint) {
  if (!RULES || !fabricHint) return null;
  const f = fabricHint.toLowerCase();
  for (const rule of (RULES.rules?.fabric_specific || [])) {
    for (const fab of (rule.match_fabrics || [])) {
      if (f.includes(fab.toLowerCase())) return rule.if;
    }
  }
  return null;
}

// Pref toggle -> use_case_situational rule id
const PREF_TO_USECASE = {
  sensitive_skin: 'sensitive_skin_eczema',
  eco_only: 'eco_conscious_zero_waste',
  hard_water: 'hard_water',
  baby_household: 'baby_clothes',
  fragrance_free: 'fragrance_free_required',
};

// "Product A; Product B" -> ["Product A", "Product B"]
// Skips semicolons that appear inside parentheses (e.g. "X (foo; bar)" stays whole).
function splitProductString(s) {
  if (!s) return [];
  const str = String(s);
  const parts = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '(') { depth++; buf += c; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); buf += c; continue; }
    if (c === ';' && depth === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

// Given the identified stain, optional fabric hint, and user prefs,
// return a ranked structured recommendation. Null if rules unavailable.
// Rules-based picker (legacy step screen). Different from the DB-driven
// pickProductsForStain() that powers the Hacks tab — see below.
function pickProductsByRules(stain, fabricHint, prefsArg) {
  if (!RULES) return null;
  const prefs = prefsArg || state.prefs || {};
  const chemClass = stainChemistryClass(stain);
  const fabClass = fabricClass(fabricHint);
  const chemRule = chemClass ? RULES.rules.stain_chemistry.find(r => r.if === chemClass) : null;
  const fabRule = fabClass ? RULES.rules.fabric_specific.find(r => r.if === fabClass) : null;
  const useCaseRules = (RULES.rules.use_case_situational || []).filter(r => {
    return Object.entries(PREF_TO_USECASE).some(([prefKey, ruleId]) => prefs[prefKey] && ruleId === r.if);
  });

  // Aggregate products, deduping on a normalized name; track which rules each came from.
  const accum = new Map();
  const accumulate = (rule, source) => {
    if (!rule?.products) return;
    for (const [role, value] of Object.entries(rule.products)) {
      for (const name of splitProductString(value)) {
        const key = name.toLowerCase().replace(/[^\w]+/g, '');
        const existing = accum.get(key);
        if (existing) {
          existing.roles.add(role);
          existing.sources.add(source);
        } else {
          accum.set(key, { name, roles: new Set([role]), sources: new Set([source]) });
        }
      }
    }
  };
  accumulate(chemRule, 'chemistry');
  accumulate(fabRule, 'fabric');
  useCaseRules.forEach(r => accumulate(r, 'use_case'));

  // Score
  const products = Array.from(accum.values()).map(p => {
    let score = 0;
    score += p.sources.size * 2; // multi-rule match is a good signal
    const roles = Array.from(p.roles);
    if (roles.some(r => r === 'primary')) score += 4;
    if (roles.some(r => /specific|specialty/.test(r))) score += 3;
    if (roles.some(r => r === 'brand_name')) score += 2;
    if (roles.some(r => r === 'pre_treater' || r === 'pre_treater_spray')) score += 2;
    if (roles.some(r => /diy/.test(r))) score -= 1;
    if (roles.some(r => r === 'sheet_eco') && prefs.eco_only) score += 3;
    if (roles.some(r => r === 'baby_variant') && prefs.baby_household) score += 4;
    // Ownership: user already has this — biggest boost
    if (prefs.has_white_hack && /white hack/i.test(p.name)) score += 6;
    if (prefs.has_oxiclean && /oxiclean/i.test(p.name)) score += 6;
    // Fragrance-free preference: boost SKUs known to be fragrance-free
    if (prefs.fragrance_free) {
      if (/free.{0,5}clear|fragrance.{0,5}free|free.{0,5}gentle/i.test(p.name)) score += 3;
    }
    // Eco preference
    if (prefs.eco_only) {
      if (/seventh generation|earth breeze|tru earth|blueland|branch basics|kind laundry|white hack|biokleen|charlie/i.test(p.name)) score += 2;
      if (/whink|chlorine bleach|krud kutter/i.test(p.name)) score -= 2;
    }
    p.score = score;
    return p;
  });

  products.sort((a, b) => b.score - a.score);

  const avoid = new Set();
  [chemRule, fabRule, ...useCaseRules].forEach(r => {
    if (r?.avoid) r.avoid.forEach(a => avoid.add(a));
  });

  const whyParts = [];
  if (chemRule?.why_it_works) whyParts.push(chemRule.why_it_works);
  if (fabRule?.why_it_works) whyParts.push(fabRule.why_it_works);

  return {
    chemistry_class: chemClass,
    fabric_class: fabClass,
    matched_use_cases: useCaseRules.map(r => r.if),
    why_it_works: whyParts.join(' ') || null,
    top_picks: products.slice(0, 5).map(p => ({
      name: p.name,
      roles: Array.from(p.roles),
      sources: Array.from(p.sources),
      score: p.score,
    })),
    avoid: Array.from(avoid),
    user_owned: products.filter(p => {
      const n = p.name.toLowerCase();
      return (prefs.has_white_hack && n.includes('white hack')) ||
             (prefs.has_oxiclean && n.includes('oxiclean'));
    }).map(p => p.name),
  };
}

// Populate the <datalist> from both V3 (50 rich) + legacy (802 long-tail).
// V3 names come first so the autocomplete suggests them when prefixes overlap.
function populateStainDatalist() {
  const dl = document.getElementById('stain-names-list');
  if (!dl) return;
  const seen = new Set();
  const opts = [];
  const addAll = src => {
    (src?.stains || []).forEach(s => {
      const key = (s.name || '').toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      opts.push(`<option value="${s.name.replace(/"/g, '&quot;')}"></option>`);
    });
  };
  addAll(PLAYBOOK_V3);
  addAll(PLAYBOOK);
  dl.innerHTML = opts.join('');
}

// Color per category (22 internal categories in the 802-stain playbook).
// Used for chips, picker buttons, and the result card. Falls back to muted grey.
// Brand-aligned per-category chip colors (gold, pink, magenta, sky, muted)
const CATEGORY_COLORS = {
  food_hot_beverages: '#FFB906', food_soft_drinks: '#FFB906', food_juices: '#FFB906',
  food_alcohol: '#FFB906', food_sauces: '#FFB906', food_dairy_chocolate: '#FFD166',
  food_other: '#FFD166',
  body_fluids: '#FF237F',
  cosmetics: '#FFB7D5', hair_body_care: '#FF87B9',
  office_art: '#A5DEF4', kids_craft: '#A5DEF4',
  outdoor_nature: '#A5DEF4', plant_garden: '#A5DEF4',
  pet_stains: '#FFD166',
  automotive: '#9CA3AF', industrial: '#9CA3AF',
  medical: '#FFB7D5',
  household_mystery: '#FFB906', cleaning_mishaps: '#FFBB1C',
  seasonal: '#FFFAF0', obscure: '#9CA3AF',
};
function catColor(id) { return CATEGORY_COLORS[id] || '#9CA3AF'; }
function catLabel(id) {
  const c = PLAYBOOK?.categories.find(x => x.id === id);
  return c?.label || id;
}
// Estimate minutes from a stain's step count + treatment_summary length.
// Difficulty: Easy | Medium | Hard. V3 stains have per-surface .difficulty (1|2|3);
// legacy stains map to Hard for known-hard sets, otherwise Medium.
function deriveDifficulty(treatment) {
  if (!treatment) return 'Medium';
  if (treatment._source === 'v3' && treatment.surfaces) {
    const surfaceKey = state.stainSurface || 'cotton';
    const d = treatment.surfaces[surfaceKey]?.difficulty
      ?? Object.values(treatment.surfaces)[0]?.difficulty
      ?? 2;
    return ['Easy','Medium','Hard'][Math.max(0, Math.min(2, d - 1))];
  }
  const HARD = ['rust','set_blood','set_yellow_armpit','set_hair_dye','super_glue','cured_paint','iodine','betadine','polymer_cured'];
  const id = ((treatment.id || treatment.name) || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (HARD.some(h => id.includes(h))) return 'Hard';
  return 'Medium';
}

// Water-temp label as a single short word, sourced from the existing parser.
function deriveWaterTemp(treatment) {
  const text = (treatment.treatment_summary || (treatment.steps || []).join(' ') || '');
  const wash = parseWashTemp(text);
  if (!wash) return 'Cool';
  if (wash.kind === 'hot') return 'Hot';
  if (wash.kind === 'warm') return 'Warm';
  if (wash.kind === 'cold') return 'Cold';
  return 'Cool';
}

function estimateMinutes(stain) {
  const steps = (stain.steps || []).length;
  const text = (stain.treatment_summary || '').toLowerCase();
  if (text.includes('overnight') || text.includes('hours')) return 30;
  if (text.includes('30 min') || text.includes('1 hour')) return 15;
  if (steps <= 2) return 3;
  if (steps <= 4) return 5;
  return 8;
}

// Realistic per-step time in seconds, scanning text for explicit cues.
function estimateStepSeconds(text) {
  const t = (text || '').toLowerCase();
  const m = t.match(/(\d+)\s*(?:to\s*\d+\s*)?(seconds?|secs?|s\b|minutes?|mins?|min\b|hour|hr|hours)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit.startsWith('h')) return n * 3600;
    if (unit.startsWith('min')) return n * 60;
    return n;
  }
  if (t.includes('overnight')) return 8 * 3600;
  if (t.includes('soak')) return 30 * 60;
  if (t.includes('rinse')) return 30;
  if (t.includes('blot')) return 30;
  if (t.includes('wash')) return 45 * 60;
  return 60;
}

// Parse wash temperature from text. Returns { label, fahrenheit, kind }
// kind: 'cold' | 'warm' | 'hot' | 'boiling' | 'none' — drives chip color.
function parseWashTemp(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('boiling') || t.includes('140°f') || t.includes('140f') || t.includes('140 f')) {
    return { label: 'Boiling water', fahrenheit: '~200°F', kind: 'hot' };
  }
  if (t.includes('hot water') || t.includes('hot wash') || (t.includes(' hot ') && !t.includes('hot sauce'))) {
    return { label: 'Hot water', fahrenheit: '130–140°F', kind: 'hot' };
  }
  if (t.includes('warm water') || t.includes('warm wash') || t.includes('lukewarm') || (t.includes(' warm ') && !t.includes('warm tone'))) {
    return { label: 'Warm water', fahrenheit: '90–110°F', kind: 'warm' };
  }
  if (t.includes('cold water') || t.includes('cold wash') || t.includes('cool water') || t.includes(' ice ') ||
      t.includes('cold rinse') || t.includes('cold flush')) {
    return { label: 'Cold water', fahrenheit: '50–65°F', kind: 'cold' };
  }
  return null; // no water mention
}

function load(k, fallback) {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
}
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

// --- Boot ---
window.addEventListener('DOMContentLoaded', () => {
  // Restore settings UI
  document.getElementById('api-key-input').value = localStorage.getItem(LS.key) || '';
  document.getElementById('model-select').value = localStorage.getItem(LS.model) || 'gpt-4o-mini';
  updateApiBadge();

  // Laundry photo inputs
  const sg = document.getElementById('stain-gallery-input');
  if (sg) sg.addEventListener('change', onStainFileChosen);
  const sc = document.getElementById('stain-camera-input');
  if (sc) sc.addEventListener('change', onStainFileChosen);
  const sa = document.getElementById('stain-after-input');
  if (sa) sa.addEventListener('change', onStainAfterChosen);
  // Enter on the typed-origin input triggers the search
  const typedInput = document.getElementById('stain-typed-input');
  if (typedInput) {
    typedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findByTypedName(); }
    });
  }
  // Enter on the "Pick the closest one" typed input submits as a manual pick
  const candidatesTyped = document.getElementById('stain-candidates-typed-input');
  if (candidatesTyped) {
    candidatesTyped.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSubmitCandidateName(); }
    });
  }
  loadAllPlaybooks();
  restorePrefsUI();
  // On boot the Stains view shows just the photo upload card. The cause prompt
  // appears after a photo is chosen; the result card after a match is made.
  if (state.stainScan) renderStainResult(state.stainScan);
  renderStainHistory();
  // Legacy picker render calls — no-op now since the grid was moved to Hacks.
  renderStainGroupGrid();
  renderRecentStrip();
  // Hacks tab category grid
  renderHacksCategories();
});

// --- Tabs ---
function switchTab(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (name === 'laundry') {
    loadAllPlaybooks();
    renderStainHistory();
    // Photo upload card is always visible. The cause prompt only appears after
    // a photo is chosen, and the result/typed cards only after the user picks.
    if (!state.stainScan && !state.stainTreatment) {
      hideAll(['stain-cause-prompt', 'stain-name-input-card', 'stain-countdown-card', 'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
    }
  }
  if (name === 'hacks') {
    loadAllPlaybooks();
    renderHacksCategories();
    hacksBackToCategories();
  }
}

// --- Toast ---
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// --- API key badge ---
function updateApiBadge() {
  const b = document.getElementById('api-badge');
  const has = !!localStorage.getItem(LS.key);
  b.textContent = has ? 'API connected' : 'No API key';
  b.style.color = has ? '#FFB906' : '';
  b.style.borderColor = has ? 'rgba(255,185,6,0.45)' : '';
}

// --- Settings ---
function saveSettings() {
  const key = document.getElementById('api-key-input').value.trim();
  const model = document.getElementById('model-select').value;
  if (key) localStorage.setItem(LS.key, key); else localStorage.removeItem(LS.key);
  localStorage.setItem(LS.model, model);
  updateApiBadge();
  toast('Settings saved');
}

// --- Preferences (8 toggles that personalize the product recommender) ---
const PREF_KEYS = [
  'sensitive_skin', 'eco_only', 'has_pet', 'hard_water',
  'baby_household', 'fragrance_free', 'has_white_hack', 'has_oxiclean',
];

function restorePrefsUI() {
  const prefs = state.prefs || {};
  PREF_KEYS.forEach(k => {
    const el = document.getElementById('pref-' + k);
    if (el) el.checked = !!prefs[k];
  });
}

function savePrefs() {
  const next = {};
  PREF_KEYS.forEach(k => {
    const el = document.getElementById('pref-' + k);
    if (el) next[k] = !!el.checked;
  });
  state.prefs = next;
  save(LS.prefs, next);
  // If a treatment is in progress, re-render so the new prefs flow through immediately.
  if (state.stainTreatment && document.getElementById('stain-treatment')?.style.display === 'block') {
    renderStep();
  }
  toast('Preferences saved');
}

function clearData() {
  if (!confirm('Clear your API key, preferences, and stain history on this device?')) return;
  Object.values(LS).forEach(k => localStorage.removeItem(k));
  state.stainScan = null;
  state.stainHistory = [];
  state.stainTreatment = null;
  state.prefs = {};
  document.getElementById('api-key-input').value = '';
  resetStainFlow();
  updateApiBadge();
  restorePrefsUI();
  renderStainHistory();
  toast('Cleared');
}

// =====================================================================
// LAUNDRY HACKS
// =====================================================================

const STAIN_SYSTEM_PROMPT = `You are TidyAI's stain identification assistant, backed by a curated playbook of 802 specific stain treatments compiled from r/laundry, r/CleaningTips, the KismaiAesthetics spa day community, Tide and OxiClean stain libraries, Clorox how-tos, and lifestyle blog deep-dives.

YOUR JOB
Identify the stain in the photo as precisely as you can, then return STRICT JSON. A separate playbook lookup applies the actual treatment — you NEVER prescribe one yourself, never invent steps, never make up a product name. Identification only.

================================================================
PART 1 — AI VISION IDENTIFICATION GUIDE
Use these four axes together to identify the stain. Combine all four signals before deciding.
================================================================

AXIS 1 — COLOR OF THE STAIN

• Bright yellow / yellow-orange:
   - Likely: sweat + aluminum antiperspirant (set), curry, turmeric, mustard, Mountain Dew, yellow Gatorade, pediatric amoxicillin, fake tan, spray tan, urine (dried), sunscreen-iron reaction, betadine/iodine (orange-brown), baby formula stains, paprika.
• Mustard-yellow halo around a faded older mark:
   - Likely: oxidized sweat, sebum yellowing on collar, sunscreen+iron reaction (avobenzone), set armpit stain.
• Crusty yellow ring on pillowcase / hat band:
   - Likely: drool + sebum + facial product residue, hair gel ring.
• Dusty / aged yellow on stored whites:
   - Likely: cellulose rust, age oxidation, foxing on linens, yellowed pit area.
• Bright red / vivid red wet:
   - Likely: fresh blood, red wine, ketchup, red Gatorade, hot sauce, fruit juice, cherry juice, salsa, pomegranate, red Slurpee.
• Dark red / set red:
   - Likely: dried blood, set red wine, beet juice, pomegranate, dried cherry, cranberry.
• Pink / rose:
   - Likely: faded wine, calamine lotion, fake blood diluted, raspberry, hibiscus tea, semi-permanent hair dye, lipstick.
• Red-orange with oily sheen:
   - Likely: lipstick, BBQ sauce, salsa with oil, sriracha, gochujang, pizza sauce.
• Magenta / fuchsia bright:
   - Likely: hair dye, Mountain Dew Code Red, food coloring spill, beet, Kool-Aid red.
• Light brown / tan wet:
   - Likely: coffee, tea, soy sauce, gravy, broth, latte, hoisin, Worcestershire.
• Dark brown with halo:
   - Likely: set coffee/tea/wine/soda, iron rust ring, set blood, dried iodine.
• Brown crusty:
   - Likely: dried blood, dried chocolate, dried iodine/betadine (very stubborn brown), set BBQ.
• Brown with oily sheen:
   - Likely: gravy, peanut butter, chocolate syrup, bacon grease, nutella, set buttered sauce.
• Reddish-brown rust tone:
   - Likely: iron oxide stain, set blood, dried Worcestershire, foxing.
• Solid black with sheen:
   - Likely: pen ink (ballpoint, Sharpie), mascara, eyeliner, motor oil, stove polish, shoe polish, gel eyeliner.
• Black matte / sooty:
   - Likely: fireplace ash, cigarette smoke residue, brake dust, candle soot, exhaust carbon.
• Black with metallic sheen:
   - Likely: pencil graphite, charcoal, silver nitrate (rare lab), iron transfer.
• Black greasy spread:
   - Likely: bike chain, axle grease, road tar, asphalt sealer.
• Bright blue:
   - Likely: ballpoint pen ink, blue Gatorade, blue ice pop, blue marker, mouthwash, surgical marker, Windex.
• Green sheen:
   - Likely: grass, plant chlorophyll, slime, kid's marker, gochujang, spinach, pesto layer.
• Olive / dark green:
   - Likely: pesto, guacamole oil layer, fresh henna paste, algae, matcha, kale.
• Purple / violet:
   - Likely: berry juices (blueberry, blackberry), grape soda, beet juice, surgical marker, mulberry.
• Clear / colorless oily sheen on dry fabric:
   - Likely: cooking oil, butter, body lotion, sunscreen, body oil, salad dressing, hair oil, beard oil, mineral oil.
• Looks like water but fabric stiff when dry:
   - Likely: hairspray buildup, perfume on silk, super glue residue, fabric paint set, white wine that dried.
• Damp halo with no clear color:
   - Likely: white wine (yellows over time), Sprite, sugary clear drinks, saliva, fresh urine.
• Chalky white on dark fabric:
   - Likely: deodorant marks (fresh), mineral hard water spots, salt tide line, mineral sunscreen residue.
• Pearly white powder:
   - Likely: setting powder, makeup powder, talc/baby powder, cornstarch, baby powder substitute.
• Flaky white residue ring:
   - Likely: detergent buildup, hard water residue, soap scum, fabric softener overdose.

AXIS 2 — TEXTURE AND APPEARANCE

• Glossy / oily sheen → fat- or oil-based stain (cosmetics, food oil, lotion, sunscreen, lipstick, mascara, BBQ sauce, peanut butter, butter). Treatment cue: a surfactant is needed before anything else.
• Crusty / dry / cracked → protein-based and set (dried blood, milk, egg, dairy, sweat, vomit, urine). Treatment cue: cold water only, enzyme detergent; hot water cooks proteins in.
• Sticky / tacky residue → sugar, glue, sap, or polymer (gum, super glue, syrup, slime, jam, tape residue, candle wax warm, semi-dry nail polish). Treatment cue: identify base — sugar dissolves in water, polymer needs solvent, wax needs heat-extraction.
• Powdery / loose → dry pigment (makeup powder, pollen, ash, dry clay, dirt, chalk, paprika, cocoa, baby powder). Treatment cue: brush off DRY first; never rub, never wet.
• Crystalline / sparkly → dried salt or sugar (salt tide on boots, sugar crystallized from jam, kombucha residue). Treatment cue: water dissolves both.
• Fuzzy / coated → organic growth (mold, mildew, lichen, fabric fluff bonded to dye transfer). Treatment cue: vinegar soak + hot wash + sunlight.
• Hardened / brittle → cured polymer or wax (dried glue, cured paint, dried candle wax, dried nail polish, ski wax). Treatment cue: scrape mechanically first, then identify polymer/wax for the right solvent.

AXIS 3 — LOCATION ON GARMENT

• Collar / neckline:
   - Yellow grime ring → sebum + sweat + hair products + sunscreen ("ring around the collar").
   - Red/pink smudge → lipstick or makeup transfer.
   - Brown stripe → hair dye transfer, foundation transfer, fake tan.
• Armpit / under-sleeve:
   - Yellow halo → sweat + aluminum antiperspirant reaction (most common stain on white shirts).
   - White chalk marks → fresh deodorant residue.
   - Stiff fabric → set antiperspirant + body oil.
• Lap / front of thigh → most likely food or drink spill — match color cue.
• Knee / front of shin → grass (green), dirt (brown), blood (kids), road rash residue, motor oil (workwear), paint.
• Bum / lower back → outdoors: grass, dirt, mud, wet bench paint, tree sap. Period accidents on white pants: blood along the seat seam.
• Cuff / wrist → hand contact: ink, marker, food handling smudges, soap residue.
• Hem / floor contact → dirt, mud, salt tide line, oil from auto shop floor, pet drag marks.
• Pocket area → pen ink (forgotten pen in dryer), mechanical pencil lead, lip balm melted, gum melted, candy.

AXIS 4 — FRESHNESS SIGNAL

• Wet dark border around stain → fresh, easiest treatment.
• Halo ring (especially yellow) around stain → was washed but residue oxidized in dryer heat — much harder to remove.
• Crusty edge on colored stain → protein dried (blood, dairy, egg).
• Sticky outside edge → sugar-based (soda, syrup, juice). Wash before it caramelizes.
• Stiff fabric, slight relief texture → paint, glue, or hair product cured — needs solvent.
• Cracked, peeling color → old hair dye, henna, or oxidized blood. Often partial recovery only.

================================================================
PART 2 — CATEGORY STRUCTURE (802 stains across 22 internal categories)
You return ONE name as exactly written in the relevant list. If the stain you see is very close to a listed name but not exact, return the closest match — a fuzzy lookup runs after you. Examples per category (not exhaustive):
================================================================

FOOD & DRINK — HOT BEVERAGES (food_hot_beverages):
Black coffee, Coffee with cream, Latte / cappuccino, Espresso, Iced coffee, Cold brew concentrate, Coffee creamer (powdered, dry), Coffee creamer (liquid, sugary), Black tea, Green tea, Herbal tea (red rooibos, hibiscus), Matcha (green powder + milk), Bubble tea (boba) — milk tea drip, Chai tea (spiced + milk), Hot chocolate, Mocha / chocolate latte, Coffee shop syrup (caramel/vanilla), Pumpkin spice latte, Honey-sweetened tea, Tea bag residue.

FOOD & DRINK — SOFT DRINKS (food_soft_drinks):
Cola (Coke / Pepsi / dark soda), Root beer, Diet cola, Citrus soda (Sprite, 7Up), Mountain Dew (neon yellow), Orange soda (Fanta), Grape soda, Cream soda, Energy drink (Red Bull, Monster), Red Bull (yellow), Energy drink (green/blue artificial), Kombucha, Tonic water (quinine), Ginger ale / ginger beer, Slurpee / slushie (red), Slurpee / slushie (blue), Sno-cone syrup.

FOOD & DRINK — JUICES (food_juices):
Orange juice, Grapefruit juice, Apple juice, Cranberry juice, Pomegranate juice, Grape juice, Cherry juice, Beet juice, Carrot juice, Tomato juice, Pineapple juice, Mango juice / smoothie, Pickle juice, V8 / vegetable juice, Lemon / lime juice, Aloe juice / aloe vera gel, Coconut water, Watermelon juice.

FOOD & DRINK — ALCOHOL (food_alcohol):
Red wine, White wine, Rosé wine, Champagne / sparkling wine, Mulled wine (spiced red), Sangria, Port wine, Beer (light), Beer (dark / stout), Beer foam dried, Bloody Mary, Margarita, Mojito, Piña colada, Cosmopolitan, Espresso martini, Whiskey, Bourbon / rum, Tequila, Vodka, Liqueur (Baileys / cream liqueur), Liqueur (coffee — Kahlúa), Aperol / Campari, Vermouth, Hot toddy.

FOOD & DRINK — SAUCES (food_sauces):
Ketchup, Yellow mustard, Dijon mustard, Whole grain mustard, Mayonnaise, Tomato sauce / marinara, Pasta sauce with meat, Pizza sauce + grease ring, BBQ sauce, Hot sauce (red, vinegar-based), Sriracha, Tabasco, Buffalo sauce, Gochujang, Sambal oelek, Soy sauce, Teriyaki sauce, Hoisin sauce, Fish sauce, Oyster sauce, Worcestershire sauce, Ponzu / yuzu sauce, Pad Thai sauce, Curry (yellow Thai), Curry (red Thai), Curry (green Thai), Curry (Indian butter chicken), Curry (Japanese), Turmeric (powder, dry), Saffron, Paprika, Chili powder / cayenne, Mustard powder, Salsa (red), Salsa verde, Guacamole, Hummus, Pesto, Alfredo sauce, Ranch dressing, Caesar dressing, Italian dressing, Vinaigrette, Thousand Island dressing, Tahini, Peanut sauce / peanut butter, Chimichurri, Tartar sauce, Honey mustard, Honey, Maple syrup, Corn syrup, Molasses, Agave nectar.

FOOD & DRINK — CHOCOLATE / DAIRY / EGGS (food_dairy_chocolate):
Milk chocolate, Dark chocolate, White chocolate, Hot chocolate (drink), Chocolate syrup, Nutella / hazelnut spread, Cocoa powder dry, Mocha drink, Ice cream (vanilla), Ice cream (chocolate), Ice cream (strawberry), Gelato, Sorbet (fruit), Popsicle (red), Popsicle (orange/yellow), Popsicle (blue), Milk, Whole milk (set / sour), Buttermilk, Cream / heavy cream, Yogurt (plain), Yogurt (fruit), Sour cream, Cottage cheese, Cheese melted (mozzarella), Cheese (blue cheese), Cream cheese, Cheese sauce / nacho cheese, Eggnog, Egg yolk, Egg white, Scrambled egg, Hollandaise sauce, Whipped cream / Cool Whip, Butter / margarine, Ghee (clarified butter), Lard / cooking fat, Bacon grease.

FOOD & DRINK — OTHER FOODS (food_other):
Cooking oil (canola/vegetable), Olive oil, Coconut oil, Sesame oil, Avocado / mashed avocado, Avocado oil, Olives (oil + brine), Jam (strawberry), Jam (raspberry / berry), Jam (apricot / peach), Marmalade, Jelly (grape), Caramel, Toffee / butterscotch, Marshmallow, Sticky candy (gummi), Lollipop residue, Chewing gum, Bubble gum (pink), Tomato (raw, fresh), Spaghetti sauce drips, Lasagna drips, Pesto (oily green), Soup (clear broth), Soup (cream-based), Soup (tomato), Miso paste, Pickle juice / vinegar spill, Sauerkraut, Kimchi, Sushi soy + wasabi, Sushi rice (sticky), Onion juice (clear), Garlic oil, Beet (raw), Carrot (cooked), Spinach (cooked), Pomegranate seeds (juice burst), Kiwi, Banana (mashed), Mango (ripe pulp), Peach juice, Pineapple (juice + pulp), Lemon zest / oil, Vanilla extract.

BODY FLUIDS (body_fluids):
Blood (fresh), Blood (dried, 24h+), Blood (set, washed already), Menstrual blood (fresh), Menstrual blood (set on underwear), Nose bleed, Sweat (fresh), Sweat (yellow pit stains), Sweat (collar grime / ring), Sweat (gym clothes funk), Sweat (back / lower back), Body oil yellowing (sebum on collar), Vomit (fresh), Vomit (dried), Bile / acid reflux, Saliva / drool (sleep stain on pillowcase), Drool on baby clothes, Phlegm / mucus, Earwax, Semen, Breast milk (fresh), Breast milk (set yellow), Baby spit-up, Baby formula, Diaper blowout (poop), Wound drainage / pus, Tears + mascara, Skin oil rings on hat band, Foot sweat (shoe interior).

COSMETICS & MAKEUP (cosmetics):
Lipstick (matte), Lipstick (glossy / waxy), Lipstick (liquid lip tint), Lipstick (red on white collar), Lip gloss, Lip balm (Chapstick), Lip liner pencil, Foundation (liquid), Foundation (powder), Foundation (cream/stick), Foundation (full coverage / waterproof), BB cream / CC cream, Tinted moisturizer, Concealer (liquid), Concealer (stick), Blush (powder), Blush (cream), Bronzer (powder), Contour stick, Highlighter cosmetic (cream), Setting spray, Setting powder, Brow gel, Brow pomade, Brow pencil, Brow tint, Mascara (regular), Mascara (waterproof), Mascara (clear), Eyeliner (liquid), Eyeliner (pencil), Eyeliner (gel), Eyeshadow (powder), Eyeshadow (cream), Eyeshadow (glitter), False eyelash glue, Lash extension adhesive (cyanoacrylate), Nail polish (wet), Nail polish (dried), Gel polish (cured), Nail polish remover spill, Acrylic nail dust, Nail glue.

HAIR & BODY CARE (hair_body_care):
Hair dye (fresh, semi-permanent), Hair dye (fresh, permanent), Hair dye (set / dried), Bleach (hair bleach from salon), Henna paste (fresh), Henna (dried), Hair gel (clear), Hair gel (tinted root cover-up), Hair mousse, Hair pomade / hair wax, Hair oil, Hair serum, Leave-in conditioner, Dry shampoo (powder), Dry shampoo (spray, white), Hairspray (set), Hair mask (clay-based), Hair mask (oil-based), Conditioner residue, Shampoo, Dandruff shampoo, Root touch-up spray, Hair color (temporary chalk), Hair color (semi-permanent vegetable dye), Deodorant white marks (fresh), Antiperspirant aluminum yellowing (set), Spray deodorant (set), Body lotion, Body butter, Body oil, Hand cream, Face cream / moisturizer, Sunscreen (fresh, white), Sunscreen (mineral / zinc oxide white residue), Sunscreen (chemical, set yellow on whites), Sunscreen + chlorine yellow (pool), Spray tan (fresh), Spray tan (dried streaks), Self-tanner / tan mousse, Tan drops (face), Perfume (alcohol-based), Cologne, Solid perfume / oil-based perfume, Body spray, Essential oil, Massage oil, Tea tree oil, Aromatherapy oil blend, Wax depilatory (cool), Wax depilatory (warm/strip wax), Sugar wax, Nair / depilatory cream, Threading paste / shaving foam.

OFFICE, INK & ART (office_art):
Ballpoint ink (blue, fresh), Ballpoint ink (black), Ballpoint ink (red), Ballpoint ink (other colors), Ballpoint ink (set, washed already), Gel pen ink, Rollerball ink, Fountain pen ink (water-based), India ink, Calligraphy ink, Permanent marker / Sharpie (black), Permanent marker (other colors), Highlighter (yellow), Highlighter (pink), Highlighter (green/blue), Dry erase marker, Wet erase marker, Chalk marker / liquid chalk, Fabric marker (washable), Fabric marker (permanent), Paint marker (oil-based), Crayon (room temperature), Crayon (melted in dryer onto load), Crayon on wall (washable), Pencil graphite, Mechanical pencil lead, Colored pencil, Charcoal pencil, Oil pastel, Soft pastel powder, Watercolor paint (wet), Watercolor (dried), Acrylic paint (wet), Acrylic paint (dried), Oil paint (artist), Gouache paint, Tempera paint, Finger paint, Latex wall paint (wet), Latex wall paint (dried), Oil-based wall paint, Spray paint (fresh, wet), Spray paint (dried), Fabric paint (set), Glow-in-the-dark paint, Metallic paint, Enamel paint, White school glue (wet), White school glue (dried), Super glue (cyanoacrylate), Hot glue (cooled), Fabric glue, Wood glue, Contact cement, Epoxy (mixed), Rubber cement, Spray adhesive, Double-sided tape adhesive, Duct tape residue, Masking tape residue, Electrical tape residue, Sticker / label adhesive, Glitter glue (wet), Glitter (loose), Slime (commercial), Slime (homemade with borax), Silly Putty / thinking putty, Play-Doh, Polymer clay (Sculpey, fresh), Polymer clay (baked), Modeling clay (oil-based), Pottery clay / ceramic slip, Charcoal (art).

OUTDOOR & NATURE (outdoor_nature):
Grass, Mud (garden soil), Mud (clay-heavy), Wet leaves stain (chlorophyll), Tree sap / pine resin (fresh), Tree sap (old / polymerized), Pine pitch (heavy), Maple sap, Pollen (yellow), Pollen (lily — worst), Pollen (sunflower), Bird droppings, Seagull droppings, Pigeon droppings, Insect splatter, Mosquito splatter (blood), Spider blood, Snail / slug trail, Algae (pond water), Lake water marks, Salt water marks, Frost / morning dew rings, Mossy patch, Lichen (gray-green), Soot / fireplace ash, Bonfire smoke, Cigarette smoke residue, Cigarette tar, Wood smoke, Cooking smoke (kitchen vent), Candle soot, Concrete splash (wet), Concrete dust, Plaster / drywall dust, Tar / asphalt (road), Sand, Beach sand + sunscreen combo.

PLANT & GARDEN (plant_garden):
Cilantro / parsley juice, Basil oil, Mint juice, Spinach (raw), Lettuce juice, Tomato vine / leaf, Walnut leaf juice, Mulberry, Acorn / oak stain, Berry leaf, Fig, Cherry, Wild plum, Crab apple, Citrus peel oil, Avocado pit oil, Mustard plant, Compost / soil, Fertilizer, Manure, Weed killer (Roundup), Pesticide spray.

PET STAINS (pet_stains):
Pet hair embedded, Pet hair on upholstery, Cat drool, Dog drool, Cat spray, Cat urine (fresh), Cat urine (dried), Dog urine (fresh, on carpet), Dog urine (set in carpet), Pet vomit, Pet vomit on carpet, Pet feces, Cat hairball, Rabbit / small mammal urine, Bird droppings (parakeet, parrot), Fish tank water spill (algae), Reptile shed skin oil, Flea treatment (topical, spilled), Pet shampoo residue, Cat litter dust.

AUTOMOTIVE & MECHANICAL (automotive):
Motor oil (fresh), Motor oil (set), Transmission fluid (red), Brake fluid, Power steering fluid, Hydraulic fluid, Bike chain grease, Wheel bearing grease, Axle grease, White lithium grease, Cutting fluid, Machining coolant, WD-40 overspray, Penetrating oil, 3-in-1 oil, Antifreeze, Gasoline (fresh), Diesel fuel, Kerosene, Battery acid, Battery terminal corrosion, Tire mark on white sneakers, Brake dust, Carbon / exhaust soot, Roadside asphalt sealer, Driveway sealer (water-based), Driveway sealer (asphalt-based), Brake cleaner overspray, Carburetor cleaner overspray, Welding flux, Welding slag, Furniture polish (wood), Stove polish (black), Shoe polish (black), Shoe polish (brown), Saddle soap residue, Boot wax / mink oil, Rubber scuff.

MEDICAL & MEDICINAL (medical):
Betadine / iodine (fresh, orange-brown), Betadine (set, brown), Iodine tincture, Mercurochrome, Hydrogen peroxide bubble, Surgical marker, EKG / ECG gel, Ultrasound gel, Calamine lotion (pink), Cough syrup, Pediatric antibiotic (pink amoxicillin), Pill capsule contents, Vapor rub (Vicks), Bandage adhesive residue, Topical hydrocortisone cream, Antibiotic ointment (Neosporin), Petroleum jelly (Vaseline), Bacitracin / triple antibiotic, Liquid bandage spray, Compression wrap residue, Dental fluoride, Toothpaste (white), Toothpaste (with stripes), Mouthwash, Denture cleaner foam, Eye drops, Hemorrhoid cream, Insulin pen leak.

INDUSTRIAL / SHOP / CHEMICAL (industrial):
Paint thinner / mineral spirits, Turpentine, Lacquer thinner, Acetone spill, Rubber cement thinner, Goo Gone residue, Goof Off residue, Silver nitrate, Copper sulfate, Lab dye, Tattoo ink leakage, Surgical ink prep, Conveyor grease, Printer ink (inkjet), Toner powder, Carbon paper, Receipt thermal paper smudge, Embalming fluid, Prosthetic adhesive, Photo developer fluid, Photo fixer, Photo stop bath, Pool chlorine (yellowing), Bromine (spa), Algaecide, Pool dye marker.

HOUSEHOLD / MINERAL / MYSTERY (household_mystery):
Rust / iron oxide, Iron transfer, Iron scorch (yellow-brown), Iron melted polymer, Curling iron scorch, Hot pan ring, Bleach spot, Mildew / mold (light), Mildew (heavy / black spots), Pink mold (Serratia), Hard water spots, Limescale / calcium deposits, Soap scum residue, Yellow age stains on stored whites, Cellulose rust, Yellowed pit area on white t-shirts (set), Ghost stain, Sebum yellowing (collar grime), Foxing on stored linens, Tarnished silver thread, Smoke odor, Cooking grease vapor, Candle wax (paraffin), Candle wax (beeswax), Candle wax (soy), Candle wax (colored), Lip balm, Ski wax, Surfboard wax, Chewing gum, Sticker / label adhesive residue, Tape residue, Sticker price tag glue, Color bleed, Dye transfer, Hair gel ring on collar / hat band, Pillowcase yellowing, Bug spray (DEET) damage.

SEASONAL & SPECIALTY (seasonal):
Easter egg dye, Easter chocolate cream, Halloween fake blood, Halloween face paint, Halloween candle wax, Theatrical fake blood, Theatrical character makeup, Latex prosthetic adhesive, Christmas candle wax, Christmas tree sap, Pine needle pitch, Tinsel residue, Birthday cake icing (buttercream), Birthday cake icing (fondant), Birthday candle wax, Holi powder, Diwali rangoli powder, Festival glitter + sunscreen + mud combo, Body paint (water-based festival), Body paint (oil-based theatrical), Henna (mehndi, fresh), Glow stick fluid, Glitter (chunky body glitter), Glitter (fine, festival fallout), Neon highlighter body spray, Sports drink — red Gatorade, orange Gatorade, yellow Gatorade, blue Gatorade, green / lime Gatorade, Protein shake (chocolate), Protein shake (vanilla), Pre-workout drink, Sports clay, Sports turf, Field chalk, Mouthguard saliva residue, Sweat + grass + dirt combo, Helmet sweat ring, Bicycle / skateboard road rash blood + dirt, Bicycle chain grease, Snow / road salt tide line, Ski wax, Gondola / lift grease, Camping food spill + smoke + dirt combo, Tent canvas mildew, Beach combo (sand + sunscreen + salt water), Sandcastle clay, Pool dye, Fireworks gunpowder residue, Sparkler residue, Smoke bomb (colored), Incense soot, Sage smudge stick ash, Ceremonial powder (color run race), Glow stick on carpet.

KIDS' ART, CRAFT & TOY (kids_craft):
Crayon (washable Crayola), Crayon on couch upholstery, Sidewalk chalk, Liquid chalk marker, Finger paint (washable), Tempera paint (kid), Construction paper bleed, Markers (kid's washable), Markers (kid's, claimed-washable but set), Slime (homemade), Floam beads, Magic Sand, Edible markers, Stamp ink (red), Stamp ink (black), Stamp ink (embossing), Press-on tattoo / temporary tattoo, Body paint sticks (kid), Soap bubbles solution, Bath bomb (colored).

CLEANING PRODUCTS GONE WRONG (cleaning_mishaps):
Chlorine bleach drip on colored fabric, Chlorine bleach drip on white fabric, Color-safe bleach (oxygen) overdose, Ammonia spill, Toilet bowl cleaner (acidic) spill, Drain cleaner (caustic) spill, Oven cleaner spray spillover, Disinfectant spray (Lysol), Multi-surface spray (Windex), Furniture polish (Pledge) spray, Mold remover spray, Hardwood floor cleaner, Carpet stain remover residue, Stain remover overuse, Fabric softener stain, Scent booster overdose, Laundry detergent splash.

ADDITIONAL & OBSCURE (obscure):
Foundation transfer on shirt collar, Yellow underarm shadow on white linen, Silly String, Spray foam (Great Stuff) insulation, Caulk / silicone (uncured), Caulk (cured), Wood stain (oil-based), Wood stain (water-based), Wood varnish / polyurethane, Polyurethane (spray), Latex glove dye, Latex glove powder, Air freshener spray residue, Plug-in air freshener oil leak, Reed diffuser oil spill, Hand sanitizer, Insect bite cream (calamine pink), Bug bite anti-itch gel, Insect repellent (DEET), Picaridin repellent, Permethrin (clothing pretreatment), Sticky lint roller residue, Scotch tape residue, Pressure washer detergent residue, Carpet shampoo residue, Mattress protector film residue, Curtain hem grime, Tablecloth wine + candle wax combo, White towel — pool chlorine + sunscreen yellow combo, Sneaker midsole yellowing, Mesh sneaker dirt, Suede water marks, Leather salt stain, Bookbinding glue, Diamond paint sealant residue, 3D printer filament fragment, Embroidery wash-away stabilizer residue, Iron-on adhesive, Vinyl HTV misapplied, Iron-on patch residue, Sewing machine oil drop, Knitting yarn fluff, Mascara on white pillowcase, Acne medicine bleach (benzoyl peroxide), Retinol cream, AHA/BHA chemical exfoliant, Shaving cream residue, Beard oil, Beard balm, Mustache wax, Hair fiber (Toppik powder build-up), Tooth-whitening strip residue, Pore strip residue, Acne patch residue, Pet flea collar residue, Pet flea spray, Pet odor (set in dog bed), Litter box urine on bath mat, Wet wipe residue, Baby wipe residue, Diaper rash cream (zinc oxide white), Diaper rash cream (set yellow), Baby powder (talc), Cornstarch powder, Massage candle wax, Aromatherapy bath salt dye, Sea salt body scrub, Coffee scrub, Sugar scrub, Bath bomb fizzy residue, Salt scrub residue, Charcoal face mask, Mud mask (clay), Sheet mask residue, Salicylic acid spot treatment, Adhesive bra residue, Spanx / shapewear lubricant, Hosiery glue, Nipple cover residue.

================================================================
PART 3 — RESPONSE SCHEMA
Return STRICT JSON. No markdown, no preamble, no commentary.
================================================================

Shape A — CONFIDENT (≥ 70% likely):
{
  "confident": true,
  "stain_name": "<EXACT name. The app uses laundry_playbook_v3.json (50 deeply-modeled stains: Red Wine, Coffee, Tomato Sauce, Blood, Sweat, Permanent Marker, Grass, Mud, Motor Oil, Pet Urine, Crayon, etc.) plus laundry_playbook.json (800+ long-tail). Prefer V3 names when applicable; closest match is fine — fuzzy lookup runs after>",
  "category": "<one of: food_drink | body_fluids | cosmetics | office_craft | outdoor_nature | pet | mechanical | household | seasonal>",
  "internal_category": "<the granular category id from Part 2, e.g. food_alcohol or hair_body_care>",
  "confidence": <0.7-1.0 float>,
  "color_observation": "<one short sentence on the stain's color and visual signature>",
  "texture_observation": "<oily | crusty | sticky | powdery | crystalline | fuzzy | hardened>",
  "location_observation": "<where on the garment, if visible: collar | pit | lap | knee | bum | cuff | hem | pocket | unknown>",
  "freshness": "fresh" | "set" | "unknown",
  "fabric_observation": "<one short sentence on the fabric: cotton, denim, silk, carpet, upholstery, leather, etc.>",
  "surface_observed": "<the SURFACE the stain is on, one of: cotton | polyester | carpet | hardwood | marble | leather | upholstery | tile | unknown. Use 'unknown' if you can't tell from the photo — the app will ask the user.>",
  "warning_if_any": "<one sentence about heat/bleach/fabric risk, or null>"
}

Shape B — NOT SURE:
{
  "confident": false,
  "needs_category": true,
  "reason": "<one warm sentence explaining what's ambiguous — never blame the user or photo>",
  "suggested_categories": ["<2-4 user-facing category ids: food_drink | body_fluids | cosmetics | office_craft | outdoor_nature | pet | mechanical | household | seasonal>"],
  "candidate_stains": ["<3-6 EXACT stain names from Part 2 that could match>"]
}

================================================================
PART 4 — EDGE CASES
================================================================

• Photo shows a stain on something that isn't fabric/upholstery (skin, wood, plastic, painted wall) → Return Shape B with reason like "This looks like a stain on a surface, not fabric. Want me to use the cleaning playbook instead?" and suggested_categories listing the 2-3 most likely anyway.
• Photo is too dark / blurry / out of focus → Return Shape B with reason "I can't see the stain clearly. Try a better-lit photo or pick a category."
• Multiple stains in one photo → Treat the most prominent one as the answer. Set confidence lower (0.5-0.7). User can re-scan if it was the wrong stain.
• Treatment that requires acetone, bleach, or harsh solvent → Always include a warning_if_any like "Acetone destroys acetate, rayon, modacrylic. Test a hidden seam first."

================================================================
PART 5 — TONE RULES (NEVER VIOLATE)
================================================================

• NEVER make assumptions about how the stain got there. Identify the stain, not the story.
• NEVER moralize ("you really shouldn't drink red wine on white silk").
• NEVER reference the activity that caused it ("looks like you spilled wine at dinner").
• NEVER use shame ("be more careful next time").
• NEVER use urgency manipulation ("ACT IMMEDIATELY!! TIME IS RUNNING OUT!"). "Fresh" means fresh; not "urgent."
• NEVER push a brand. Brands appear only via the playbook lookup.

Return JSON only. No prose, no markdown, no preamble.`;

// --- Origin question: shown AFTER photo is loaded ---
// Photo upload card is always visible. Question card appears once a photo
// is chosen. "Yes" reveals the typed input. "Not sure" runs the AI directly.
function showOriginQuestion() {
  hideAll(['stain-name-input-card', 'stain-countdown-card', 'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final']);
  const q = document.getElementById('stain-cause-prompt');
  if (q) q.style.display = 'block';
}

function hideOriginQuestion() {
  const q = document.getElementById('stain-cause-prompt');
  if (q) q.style.display = 'none';
}

// Yes branch: reveal the name-input card and auto-scroll into view.
function onKnowCauseYes() {
  hideOriginQuestion();
  hideAll(['stain-countdown-card', 'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final', 'stain-surface-picker', 'stain-pro-tip-card']);
  const card = document.getElementById('stain-name-input-card');
  if (!card) return;
  card.style.display = 'block';
  if (PLAYBOOK || PLAYBOOK_V3) populateStainDatalist(); else loadAllPlaybooks();
  const hints = document.getElementById('stain-typed-hints');
  if (hints) hints.innerHTML = '';
  setTimeout(() => {
    const input = document.getElementById('stain-name-input');
    if (input) input.focus();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

function onSubmitStainName() {
  const input = document.getElementById('stain-name-input');
  const val = (input?.value || '').trim();
  if (!val) return toast('Please type the stain name');
  document.getElementById('stain-name-input-card').style.display = 'none';
  pickStainManually(val);  // SAME renderer as the AI flow — no separate code path
}

// "Pick the closest one" card → user types a stain name as a third option.
// Reuses pickStainManually so the same playbook lookup + rendering applies.
function onSubmitCandidateName() {
  const input = document.getElementById('stain-candidates-typed-input');
  const val = (input?.value || '').trim();
  if (!val) return toast('Type a stain name first');
  document.getElementById('stain-needs-category').style.display = 'none';
  pickStainManually(val);
}

// Not sure branch: 5→1 counter paired with a progress bar. When the AI
// returns (or the count reaches 0), show "✓ Analysis done" briefly, then
// hand off to renderStainResult which scrolls the Most likely card into view.
let _stainCountdownTimer = null;
async function onKnowCauseNotSure() {
  hideOriginQuestion();
  hideAll(['stain-name-input-card', 'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final', 'stain-surface-picker', 'stain-pro-tip-card']);
  const card = document.getElementById('stain-countdown-card');
  const label = document.getElementById('stain-countdown-text');
  const fill = document.getElementById('stain-progress-fill');
  if (!card || !label) return;
  card.style.display = 'block';
  if (fill) { fill.classList.remove('complete'); fill.style.width = '0%'; }
  setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);

  const TOTAL = 5;
  let count = TOTAL;
  label.textContent = `Analyzing… ${count}`;
  if (_stainCountdownTimer) clearInterval(_stainCountdownTimer);
  _stainCountdownTimer = setInterval(() => {
    count--;
    if (count >= 1) {
      label.textContent = `Analyzing… ${count}`;
      if (fill) fill.style.width = `${((TOTAL - count) / TOTAL) * 100}%`;
    } else {
      clearInterval(_stainCountdownTimer);
      _stainCountdownTimer = null;
      if (fill) fill.style.width = '90%';
      label.textContent = 'Still analyzing…';
    }
  }, 1000);

  let analysisOK = false;
  try {
    await analyzeStain();
    analysisOK = true;
  } catch (err) {
    toast(err?.message || 'Identification failed');
  } finally {
    if (_stainCountdownTimer) { clearInterval(_stainCountdownTimer); _stainCountdownTimer = null; }
    if (analysisOK && fill && label) {
      fill.classList.add('complete');
      fill.style.width = '100%';
      label.innerHTML = '<span class="analysis-done"><span class="check">✓</span>Analysis done</span>';
      await new Promise(r => setTimeout(r, 650));
    }
    card.style.display = 'none';
    setTimeout(() => document.getElementById('stain-confident')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
}

// Back-compat (old buttons that still call setOriginMode go through the new path)
function setOriginMode(mode, btnEl) {
  if (btnEl) { btnEl.classList.add('pressed'); setTimeout(() => btnEl.classList.remove('pressed'), 250); }
  const run = () => {
    if (mode === 'known') return onKnowCauseYes();
    if (mode === 'photo') return onKnowCauseNotSure();
  };
  if (btnEl) setTimeout(run, 180); else run();
}

// --- Find by typed name (no AI call) ---
// Kept for the inline autocomplete on the name-input card. The "Find treatment"
// button now calls onSubmitStainName() (above), which delegates to pickStainManually.
function findByTypedName() {
  const input = document.getElementById('stain-name-input') || document.getElementById('stain-typed-input');
  if (!input) return;
  const text = (input.value || '').trim();
  if (!text) return toast('Type what the stain is first');
  if (!PLAYBOOK) { toast('Playbook still loading…'); return; }
  const treatment = getStainTreatment(text);
  if (treatment) {
    state.stainTreatment = treatment;
    state.stainScan = {
      confident: true, stain_name: treatment.name, category: treatment.category,
      confidence: 1.0, fabric_observation: '', freshness: 'unknown',
    };
    save(LS.lastStainScan, state.stainScan);
    renderStainResult(state.stainScan);
    return;
  }
  // No match — show the 6 closest entries inline as quick picks.
  const wantTokens = stainTokens(text);
  const ranked = (PLAYBOOK.stains || [])
    .map(s => {
      const set = new Set(stainTokens(s.name));
      let shared = 0;
      for (const t of wantTokens) if (set.has(t)) shared++;
      return { s, score: shared };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const hints = document.getElementById('stain-typed-hints');
  if (ranked.length) {
    hints.innerHTML = `
      <div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 6px">Did you mean</div>
      ${ranked.map(r => `
        <div class="candidate-row" data-stain="${escapeHtml(r.s.name)}">
          <span>${escapeHtml(r.s.name)}</span>
          <span style="color:var(--muted);font-size:18px">›</span>
        </div>
      `).join('')}
    `;
    hints.querySelectorAll('.candidate-row').forEach(el => {
      el.addEventListener('click', () => {
        input.value = el.dataset.stain;
        findByTypedName();
      });
    });
  } else {
    hints.innerHTML = `<p style="color:var(--muted);font-size:13px;margin-top:8px">Nothing in the playbook matched. Try a simpler word like "coffee" or "blood", or switch to the photo mode.</p>`;
  }
}

// --- Stain photo input ---
function onStainFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  toast('Loading photo…');
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read that file');
  reader.onload = () => {
    const dataUrl = reader.result;
    state.stainImageDataUrl = dataUrl;
    const preview = document.getElementById('stain-preview-img');
    preview.onerror = () => { preview.style.display = 'none'; };
    preview.onload = () => { preview.style.display = 'block'; };
    preview.src = dataUrl;
    document.getElementById('stain-upload-placeholder').style.display = 'none';

    // Downscale in background
    const img = new Image();
    img.onload = () => {
      try {
        const maxDim = 1024;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        state.stainImageDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      } catch (err) { console.warn('downscale failed', err); }
    };
    img.onerror = () => console.warn('decode failed, sending original');
    img.src = dataUrl;
    // Hide the gallery/camera buttons now that we have a photo; the cause prompt takes over.
    const uploadBtns = document.getElementById('stain-upload-buttons');
    if (uploadBtns) uploadBtns.style.display = 'none';
    // Guarded — the legacy "Identify stain" button may not exist in the current UI.
    const analyzeBtn = document.getElementById('stain-analyze-btn');
    if (analyzeBtn) analyzeBtn.style.display = 'none';
    showOriginQuestion();
    setTimeout(() => {
      document.getElementById('stain-cause-prompt')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// --- AI call: identifyStain ---
async function analyzeStain(optionalCategory = null) {
  if (!state.stainImageDataUrl) return toast('Add a photo first');
  const key = localStorage.getItem(LS.key);
  if (!key) { switchTab('settings'); return toast('Add your OpenAI API key in Settings'); }
  const model = localStorage.getItem(LS.model) || 'gpt-4o-mini';
  await loadAllPlaybooks();

  // NOTE: do NOT hide #stain-countdown-card here — the caller (onKnowCauseNotSure)
  // owns that card and runs its progress bar + counter. Hide only the cards
  // that would compete for screen space.
  hideAll(['stain-cause-prompt', 'stain-name-input-card', 'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final', 'stain-surface-picker', 'stain-pro-tip-card']);
  const btn = document.getElementById('stain-analyze-btn');
  const label = document.getElementById('stain-analyze-label');
  if (btn && label) { btn.disabled = true; label.innerHTML = '<span class="spinner"></span> Identifying…'; }

  const userText = optionalCategory
    ? `The user confirmed this stain falls in the category: ${optionalCategory}. Narrow within that category and return either Shape A (a confident pick) or Shape B with up to 5 candidate_stains from that category.`
    : "Identify this stain. If you're not confident, ask for a category.";

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: STAIN_SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: state.stainImageDataUrl, detail: 'low' } },
          ]},
        ],
        max_tokens: 500,
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('OpenAI error: ' + res.status + ' — ' + errText.slice(0, 200));
    }
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    state.stainScan = parsed;
    save(LS.lastStainScan, parsed);
    renderStainResult(parsed);
  } catch (err) {
    console.error(err);
    toast(err.message.length < 80 ? err.message : 'Identification failed — see console');
  } finally {
    if (btn && label) { btn.disabled = false; label.textContent = 'Identify stain'; }
  }
}

// --- Pure playbook lookup ---
// Stopwords ignored during token overlap matching
const STAIN_STOPWORDS = new Set([
  'a', 'an', 'the', 'on', 'in', 'of', 'and', 'or', 'with',
  'stain', 'stains', 'mark', 'spot', 'spots', 'residue',
  'fresh', 'set', 'dried', 'old', 'wet', 'food', 'liquid', 'general',
]);

function stainTokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 1 && !STAIN_STOPWORDS.has(t));
}

function findStainInPlaybook(stainName) {
  if (!stainName) return null;
  const want = stainName.toLowerCase().trim();

  // --- Tier 1: V3 (rich data, 50 stains) — checked first so the rich UX wins ---
  if (PLAYBOOK_V3?.stains) {
    let hit = PLAYBOOK_V3.stains.find(s => (s.name || '').toLowerCase() === want);
    if (hit) return { ...hit, _source: 'v3' };
    hit = PLAYBOOK_V3.stains.find(s => {
      const n = (s.name || '').toLowerCase();
      return n.includes(want) || want.includes(n);
    });
    if (hit) return { ...hit, _source: 'v3' };
  }

  // --- Tier 2: Legacy playbook (802 stains, long-tail) ---
  if (PLAYBOOK?.stains) {
    let hit = PLAYBOOK.stains.find(s => s.name.toLowerCase() === want);
    if (hit) return { ...hit, _source: 'legacy' };
    hit = PLAYBOOK.stains.find(s => {
      const n = s.name.toLowerCase();
      return n.includes(want) || want.includes(n);
    });
    if (hit) return { ...hit, _source: 'legacy' };
  }

  // --- Tier 3: token-overlap fuzzy match against legacy ---
  // Catches "food grease" -> "Bacon grease", "wine spill" -> "Red wine", etc.
  const wantTokens = stainTokens(stainName);
  if (!wantTokens.length || !PLAYBOOK?.stains) return null;

  let best = null;
  let bestScore = 0;
  for (const s of PLAYBOOK.stains) {
    const stainToks = stainTokens(s.name);
    if (!stainToks.length) continue;
    const stainSet = new Set(stainToks);
    let shared = 0;
    for (const t of wantTokens) if (stainSet.has(t)) shared++;
    if (shared === 0) continue;
    const score = shared / wantTokens.length;
    if (score > bestScore || (score === bestScore && best && s.name.length < best.name.length)) {
      best = s;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? { ...best, _source: 'legacy' } : null;
}

function getStainTreatment(stainName, fabricHint = null) {
  const stain = findStainInPlaybook(stainName);
  if (!stain) return null;
  // V3 stains: warnings come from never_do + common_mistakes; estimated_minutes
  // is computed per surface, so we surface "—" here and let the renderer fill in.
  if (stain._source === 'v3') {
    const warnings = [];
    if (stain.never_do) warnings.push({ fabric: 'general', warning: stain.never_do });
    return { ...stain, applicable_warnings: warnings, estimated_minutes: null };
  }
  // Legacy schema
  const fc = stain.fabric_compatibility || {};
  const warnings = [];
  if (fc.full_note) warnings.push({ fabric: 'general', warning: fc.full_note });
  if (fabricHint && Array.isArray(fc.avoid) && fc.avoid.some(f => f.toLowerCase().includes(fabricHint.toLowerCase()))) {
    warnings.unshift({ fabric: fabricHint, warning: `This treatment is risky on ${fabricHint} — test on a hidden seam first.` });
  }
  return { ...stain, applicable_warnings: warnings, estimated_minutes: estimateMinutes(stain) };
}

// --- Render: AI result (confident or category fallback) ---
function renderStainResult(parsed) {
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final', 'stain-surface-picker', 'stain-pro-tip-card', 'stain-countdown-card']);

  if (parsed && parsed.confident && parsed.stain_name) {
    const treatment = getStainTreatment(parsed.stain_name);
    if (!treatment) {
      showCategoryPicker(`I matched it to "${parsed.stain_name}" but don't have a treatment on file. Pick the closest category.`);
      return;
    }
    state.stainTreatment = treatment;
    state.surfaceFromAI = parsed.surface_observed || 'unknown';
    state.stainSurface = null;
    document.getElementById('stain-confident').style.display = 'block';
    document.getElementById('stain-name').textContent = treatment.name;

    // Uploaded photo (if any) shows ONLY on the Most likely card.
    const photo = document.getElementById('stain-result-photo');
    if (photo) {
      if (state.stainImageDataUrl) {
        photo.src = state.stainImageDataUrl;
        photo.style.display = 'block';
      } else {
        photo.style.display = 'none';
      }
    }

    const isV3 = treatment._source === 'v3';
    const water = deriveWaterTemp(treatment);
    const diff = deriveDifficulty(treatment);
    // Material chip: AI-observed surface (if AI gave one) > user-selected surface
    // (only set later by surface picker, won't be on first render).
    const materialKey = (parsed.surface_observed && parsed.surface_observed !== 'unknown') ? parsed.surface_observed : state.stainSurface;
    const materialLabel = materialKey ? (SURFACE_LABEL[materialKey] || materialKey) : null;

    // Summary line under the title: one short framing sentence.
    const summary = isV3
      ? (treatment.urgency_text || '')
      : (parsed.fabric_observation || '');
    document.getElementById('stain-summary').textContent = summary;

    // Chips: Category · Water · Difficulty · Material (no clock, no minutes)
    const catNice = isV3
      ? (treatment.category || '').replace(/-/g, ' ')
      : catLabel(treatment.category);
    const catColorVal = isV3 ? '#FFB906' : catColor(treatment.category);
    document.getElementById('stain-tags').innerHTML = `
      ${catNice ? `<span class="chip" style="color:${catColorVal};border-color:${catColorVal}66">${escapeHtml(catNice)}</span>` : ''}
      <span class="chip">💧 ${escapeHtml(water)}</span>
      <span class="chip chip-difficulty difficulty-${diff.toLowerCase()}">${diff}</span>
      ${materialLabel ? `<span class="chip">👕 ${escapeHtml(materialLabel)}</span>` : ''}
    `;

    // Warnings — Never-do (V3) or fabric warnings (legacy).
    const warningsEl = document.getElementById('stain-warnings');
    if (isV3 && treatment.never_do) {
      warningsEl.innerHTML = `<div class="never-do"><strong>⚠ Never do</strong><br>${escapeHtml(treatment.never_do)}</div>`;
    } else if (!isV3) {
      const allWarnings = [
        ...(parsed.warning_if_any ? [{ fabric: 'general', warning: parsed.warning_if_any }] : []),
        ...(treatment.applicable_warnings || []),
      ];
      warningsEl.innerHTML = allWarnings.map(w => `
        <div class="fabric-warning"><strong>⚠ Heads up</strong><br>${escapeHtml(w.warning)}</div>
      `).join('');
    } else {
      warningsEl.innerHTML = '';
    }

    // Rich-info block: about the stain + treatment summary + common mistakes +
    // pro tip + expectation + alt method + science. All inline on Most likely.
    const rich = document.getElementById('stain-rich-info');
    if (rich) {
      const aboutText = isV3
        ? (treatment.science || '')
        : (treatment.treatment_summary || '');
      const treatmentText = isV3
        ? (treatment.treatment_summary || '')
        : '';
      const blocks = [];
      if (aboutText) blocks.push(`<div class="info-block about"><h4>About this stain</h4><p>${escapeHtml(aboutText)}</p></div>`);
      if (treatmentText && treatmentText !== aboutText) {
        blocks.push(`<div class="info-block treatment"><h4>How to treat it</h4><p>${escapeHtml(treatmentText)}</p></div>`);
      }
      if (isV3 && Array.isArray(treatment.common_mistakes) && treatment.common_mistakes.length) {
        blocks.push(`
          <div class="common-mistakes" style="margin-top:12px">
            <h5>⚠ Common mistakes</h5>
            <ul>${treatment.common_mistakes.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
          </div>
        `);
      }
      if (isV3 && treatment.pro_tip)    blocks.push(`<div class="info-block pro-tip"><h4>💡 Pro tip</h4><p>${escapeHtml(treatment.pro_tip)}</p></div>`);
      if (isV3 && treatment.expectation) blocks.push(`<div class="info-block expectation"><h4>📊 What to expect</h4><p>${escapeHtml(treatment.expectation)}</p></div>`);
      if (isV3 && treatment.alt_method)  blocks.push(`<div class="info-block alt-method"><h4>🔁 Alt method</h4><p>${escapeHtml(treatment.alt_method)}</p></div>`);

      // Alternative products — consolidated single list (no per-step dupe).
      // Prefer V3 brand picks; fall back to surface generic items or legacy products.
      let altList = [];
      if (isV3) {
        const tp = treatment.tidyai_products || {};
        if (Array.isArray(tp.primary)) altList = altList.concat(tp.primary);
        // Pull a surface's generic items if a surface is already selected
        const surfKey = state.stainSurface || (parsed.surface_observed && parsed.surface_observed !== 'unknown' ? parsed.surface_observed : null);
        if (surfKey && treatment.surfaces?.[surfKey]?.products) {
          altList = altList.concat(treatment.surfaces[surfKey].products);
        }
      } else if (Array.isArray(treatment.products)) {
        altList = treatment.products.map(p => p?.name || p);
      }
      // Dedupe by lowercased name (kept simple — no need for brand inference here)
      const seenAlt = new Set();
      const altClean = [];
      for (const item of altList) {
        const s = String(item || '').trim();
        const key = s.toLowerCase();
        if (!s || seenAlt.has(key)) continue;
        seenAlt.add(key);
        altClean.push(s);
      }
      if (altClean.length) {
        blocks.push(`
          <div class="info-block">
            <h4>Alternative products</h4>
            <ul style="margin:6px 0 0;padding-left:18px;line-height:1.6">
              ${altClean.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
            </ul>
          </div>
        `);
      }
      rich.innerHTML = blocks.join('');
    }
  } else if (parsed && parsed.needs_category) {
    showCategoryPicker(parsed.reason, parsed.suggested_categories, parsed.candidate_stains);
  }
}

// Shape B (AI not sure). Cap candidates to 2 and always offer a free-text
// "type the stain" fallback so the user is never stuck if the AI's guesses
// are off. No "or pick a category" — the category grid lives only in Hacks.
function showCategoryPicker(reason, _ignoredSuggestedCats, candidateStains) {
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final', 'stain-surface-picker', 'stain-pro-tip-card']);
  const card = document.getElementById('stain-needs-category');
  if (!card) return;
  card.style.display = 'block';

  const reasonEl = document.getElementById('stain-needs-reason');
  if (reasonEl) reasonEl.textContent = reason || "I couldn't tell for sure — which looks closest?";

  // Make sure the datalist is populated for the typed-input autocomplete
  if (PLAYBOOK || PLAYBOOK_V3) populateStainDatalist(); else loadAllPlaybooks();
  // Clear any prior text so the user starts fresh each time the card opens
  const typedInput = document.getElementById('stain-candidates-typed-input');
  if (typedInput) typedInput.value = '';

  const list = document.getElementById('stain-candidates-list');
  if (!list) return;
  const candidates = (Array.isArray(candidateStains) ? candidateStains : []).slice(0, 2);
  if (!candidates.length) {
    list.innerHTML = `<p style="color:var(--muted);font-size:13px">I don't have a close guess — type the stain below and I'll match it.</p>`;
  } else {
    list.innerHTML = candidates.map(name => `
      <button class="stain-row" data-stain="${escapeHtml(name)}" style="display:flex;align-items:center;justify-content:space-between;padding:14px;background:var(--card-strong);border:1px solid var(--border);border-radius:12px;font-size:14px;color:var(--text);cursor:pointer;min-height:48px;text-align:left;width:100%;margin-bottom:8px">
        <span>${escapeHtml(name)}</span>
        <span style="color:var(--muted)">›</span>
      </button>
    `).join('');
    list.querySelectorAll('button[data-stain]').forEach(btn => {
      btn.addEventListener('click', () => pickStainManually(btn.dataset.stain));
    });
  }
}

// pickCategory is no longer used (the category grid was removed from the
// candidates view). Kept as a no-op so any stale onclick attribute doesn't error.
function pickCategory() { /* removed in v10 — Hacks tab owns category browsing */ }

function pickCandidate(stainName) {
  const treatment = getStainTreatment(stainName);
  if (!treatment) {
    // Last-resort: show the user the 6 closest playbook entries by token overlap.
    const wantTokens = stainTokens(stainName);
    const ranked = (PLAYBOOK?.stains || [])
      .map(s => {
        const toks = stainTokens(s.name);
        const set = new Set(toks);
        let shared = 0;
        for (const t of wantTokens) if (set.has(t)) shared++;
        return { s, score: shared };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(r => r.s.name);
    if (ranked.length) {
      showCategoryPicker(`I couldn't find "${stainName}" exactly. Did you mean one of these?`, null, ranked);
    } else {
      toast("Couldn't find that one — pick a category instead");
    }
    return;
  }
  // Use the playbook's canonical name (in case the AI candidate was a near-match)
  state.stainTreatment = treatment;
  state.stainScan = {
    confident: true, stain_name: treatment.name, category: treatment.category,
    confidence: 1.0, fabric_observation: '', freshness: 'unknown',
  };
  save(LS.lastStainScan, state.stainScan);
  renderStainResult(state.stainScan);
}

// V3 surface fallback chain: when the AI picks (or user requests) a surface not
// present in the V3 stain's surfaces, fall through in this order. Per the spec.
const V3_SURFACE_ORDER = ['cotton', 'polyester', 'upholstery', 'carpet', 'tile', 'hardwood', 'marble', 'leather'];
const SURFACE_EMOJI = {
  cotton: '👕', polyester: '🎽', carpet: '🪺', upholstery: '🛋', leather: '👜',
  hardwood: '🪵', marble: '🪨', tile: '🧱',
};
const SURFACE_LABEL = {
  cotton: 'Cotton', polyester: 'Polyester', carpet: 'Carpet', upholstery: 'Upholstery',
  leather: 'Leather', hardwood: 'Hardwood', marble: 'Marble', tile: 'Tile',
};

// Resolve a V3 stain + desired surface to the actual surface key we'll use.
// Returns the requested surface if it exists, otherwise the closest fallback,
// otherwise the first surface in the stain's surfaces map.
function resolveV3Surface(stain, desired) {
  if (!stain?.surfaces) return null;
  const keys = Object.keys(stain.surfaces);
  if (!keys.length) return null;
  if (desired && keys.includes(desired)) return desired;
  for (const s of V3_SURFACE_ORDER) {
    if (keys.includes(s)) return s;
  }
  return keys[0];
}

// --- Treatment step flow ---
function startTreatment() {
  if (!state.stainTreatment) return toast('Identify the stain first');
  const t = state.stainTreatment;
  state.stainStepIndex = 0;
  hideAll(['stain-confident', 'stain-needs-category', 'stain-final', 'stain-surface-picker', 'stain-pro-tip-card']);

  // V3: route through surface picker (unless AI gave us a valid one already).
  if (t._source === 'v3' && t.surfaces) {
    const aiSurface = state.surfaceFromAI;
    if (aiSurface && aiSurface !== 'unknown' && t.surfaces[aiSurface]) {
      // AI surface is valid in this stain's V3 entry — go straight to treatment.
      state.stainSurface = aiSurface;
      document.getElementById('stain-treatment').style.display = 'block';
      renderStep();
      return;
    }
    // Otherwise show the picker.
    showSurfacePicker();
    return;
  }

  // Legacy: jump to step 1 as before.
  document.getElementById('stain-treatment').style.display = 'block';
  renderStep();
}

function showSurfacePicker() {
  const t = state.stainTreatment;
  if (!t?.surfaces) { document.getElementById('stain-treatment').style.display = 'block'; renderStep(); return; }
  hideAll(['stain-confident', 'stain-needs-category', 'stain-final', 'stain-treatment', 'stain-pro-tip-card']);
  const card = document.getElementById('stain-surface-picker');
  if (!card) return;
  card.style.display = 'block';

  // Hint copy: name the stain so the picker feels specific.
  document.getElementById('stain-surface-picker-hint').textContent =
    `Where is the ${t.name?.toLowerCase() || 'stain'}? Steps adapt to the surface.`;

  // Order surfaces with the available V3 keys first, then any extras.
  const available = Object.keys(t.surfaces);
  const ordered = V3_SURFACE_ORDER.filter(s => available.includes(s)).concat(available.filter(s => !V3_SURFACE_ORDER.includes(s)));
  const aiSurface = state.surfaceFromAI && state.surfaceFromAI !== 'unknown' ? state.surfaceFromAI : null;

  document.getElementById('stain-surface-grid').innerHTML = ordered.map(s => {
    const isRec = s === aiSurface;
    return `
      <button class="surface-btn press-gold ${isRec ? 'recommended' : ''}" data-surface="${s}">
        <span class="surface-emoji">${SURFACE_EMOJI[s] || '·'}</span>
        <span>${escapeHtml(SURFACE_LABEL[s] || s)}</span>
        ${isRec ? '<span class="surface-tag">AI guess</span>' : ''}
      </button>
    `;
  }).join('');
  document.getElementById('stain-surface-grid').querySelectorAll('.surface-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.add('pressed');
      setTimeout(() => pickSurface(btn.dataset.surface), 200);
    });
  });
}

function pickSurface(surface) {
  const t = state.stainTreatment;
  if (!t) return;
  state.stainSurface = resolveV3Surface(t, surface);
  state.stainStepIndex = 0;
  hideAll(['stain-surface-picker']);
  document.getElementById('stain-treatment').style.display = 'block';
  renderStep();
}

function renderStep() {
  const t = state.stainTreatment;
  if (!t) return;
  // Route to V3 step renderer when applicable; legacy path is untouched.
  if (t._source === 'v3') return renderStepV3();

  const steps = t.steps || [];
  const i = state.stainStepIndex;
  if (i >= steps.length) return finishTreatment();
  const isLast = i === steps.length - 1;
  // New schema: steps are plain strings. Old schema: { action, seconds }.
  const raw = steps[i];
  const actionText = typeof raw === 'string' ? raw : (raw?.action || '');
  const seconds = typeof raw === 'object' && raw?.seconds ? raw.seconds : estimateStepSeconds(actionText);
  const wash = parseWashTemp(actionText);

  document.getElementById('step-counter').textContent = `Step ${i + 1} of ${steps.length}`;
  // Append the "rinse and dry if needed" hint on the final step
  const finalHint = isLast ? '<div style="font-size:13px;color:var(--muted);margin-top:10px">When you’re done, rinse with cold water and air-dry. Skip the dryer until the stain is fully gone — heat sets any residue.</div>' : '';
  document.getElementById('step-action').innerHTML = escapeHtml(actionText) + finalHint;

  // Time + temperature row (both visible per step)
  document.getElementById('step-time').innerHTML = `
    <span class="step-time">⏱ ${formatSeconds(seconds)}</span>
    ${wash ? `<span class="wash-chip ${wash.kind}" style="margin-left:6px">💧 ${escapeHtml(wash.label)} · ${escapeHtml(wash.fahrenheit)}</span>` : ''}
  `;

  // Back button always alive — on step 1 it returns to the result card.
  const back = document.getElementById('step-back-btn');
  back.disabled = false;
  back.textContent = i === 0 ? '◀ Back' : '◀ Back';

  // Next vs Done — finish
  document.getElementById('step-next-btn').textContent = isLast ? 'Finish' : 'Done — next ▶';

  // Products section — try the if-then rule engine first (personalized to user
  // prefs and chemistry class). If RULES failed to load or no match is found,
  // fall back silently to the playbook's static products.
  const prodWrap = document.getElementById('step-products-wrap');
  const rec = pickProductsByRules(t, null, state.prefs);
  const roleNice = r => {
    if (!r) return '';
    const s = String(r).toLowerCase();
    if (s === 'primary') return 'first choice';
    if (s === 'alternative' || s === 'alt') return 'alternative';
    if (s === 'pre_treater' || s === 'pre_treater_spray') return 'pre-treater';
    if (s === 'sheet_eco') return 'eco sheet';
    if (s === 'baby_variant') return 'baby variant';
    if (s === 'brand_name') return 'brand-name option';
    if (s === 'diy_fallback' || s === 'diy_backup') return 'DIY fallback';
    if (s.includes('specific')) return 'best for this stain';
    return s.replace(/_/g, ' ');
  };
  let html = '';
  if (rec && rec.top_picks && rec.top_picks.length) {
    const ownedSet = new Set(rec.user_owned.map(n => n.toLowerCase()));
    const chemNice = rec.chemistry_class ? rec.chemistry_class.replace(/_/g, ' ') : null;
    const fabNice = rec.fabric_class ? rec.fabric_class.replace(/_/g, ' ') : null;
    html += `
      <div class="rec-card">
        <h4>Recommended for you</h4>
        <div class="rec-meta">
          ${chemNice ? `Stain class: <strong style="color:var(--text)">${escapeHtml(chemNice)}</strong>` : ''}
          ${fabNice ? ` · Fabric: <strong style="color:var(--text)">${escapeHtml(fabNice)}</strong>` : ''}
        </div>
        <ul>
          ${rec.top_picks.map(p => {
            const isOwned = ownedSet.has(p.name.toLowerCase());
            const primaryRole = p.roles[0] || '';
            return `<li>${escapeHtml(p.name)}${isOwned ? ' <span class="owned-tag">you own</span>' : ''}${primaryRole ? ` <span style="color:var(--muted)">— ${escapeHtml(roleNice(primaryRole))}</span>` : ''}</li>`;
          }).join('')}
        </ul>
        ${rec.avoid.length ? `<div class="avoid"><strong>Avoid:</strong> ${rec.avoid.map(escapeHtml).join(', ')}</div>` : ''}
        ${rec.why_it_works ? `<div class="why">${escapeHtml(rec.why_it_works)}</div>` : ''}
      </div>
    `;
  }
  // Always show the playbook's static products too — they're the source-of-truth
  // for what the playbook itself recommends, and the user might already trust those.
  if (t.products && t.products.length) {
    html += `
      <div class="step-products" style="margin-top:10px">
        <strong>Alternative products</strong>
        <ul>${t.products.map(p => `<li>${escapeHtml(p.name)}${p.role ? ` <span style="color:var(--muted)">— ${escapeHtml(roleNice(p.role))}</span>` : ''}</li>`).join('')}</ul>
      </div>
    `;
  }
  prodWrap.innerHTML = html;
}

// V3 step renderer — surface-aware, with stars, time, common-mistakes (step 1),
// TidyAI picks, and inline preference variant callouts.
function renderStepV3() {
  const t = state.stainTreatment;
  const surface = state.stainSurface || resolveV3Surface(t, state.surfaceFromAI);
  if (!surface) return finishTreatment();
  state.stainSurface = surface;
  const surfData = t.surfaces[surface] || {};
  const steps = surfData.steps || [];
  const i = state.stainStepIndex;
  if (i >= steps.length) return finishTreatment();
  const isLast = i === steps.length - 1;
  const actionText = String(steps[i] || '');

  const surfaceLabel = SURFACE_LABEL[surface] || surface;
  document.getElementById('step-counter').innerHTML =
    `${escapeHtml(t.name)} · ${escapeHtml(surfaceLabel)} · Step ${i + 1} of ${steps.length}`;

  document.getElementById('step-action').innerHTML = escapeHtml(actionText);

  // No clock, no minutes. Only show a wash-temperature chip if the step
  // explicitly mentions water at a specific temperature.
  const wash = parseWashTemp(actionText);
  document.getElementById('step-time').innerHTML = wash
    ? `<span class="wash-chip ${wash.kind}">💧 ${escapeHtml(wash.label)} · ${escapeHtml(wash.fahrenheit)}</span>`
    : '';

  document.getElementById('step-back-btn').disabled = false;
  document.getElementById('step-next-btn').textContent = isLast ? 'Finish' : 'Done — next ▶';

  // Alternative products are shown ONCE on the Most likely card (no per-step
  // duplication). Step screens stay lean: action + wash temp + variants.
  const prodWrap = document.getElementById('step-products-wrap');
  let html = '';

  // Preference variant callouts — still surfaced per step where the data exists.
  const variants = t.if_then_variants || {};
  const prefs = state.prefs || {};
  const variantLabels = {
    sensitive_skin: '🌿 Sensitive skin',
    white_hack: '💧 With White Hack',
    eco_only: '🌱 Eco only',
    baby_household: '🍼 Baby in the home',
    hard_water: '💎 Hard water',
    has_pet: '🐾 Has pet',
  };
  const PREF_TO_VARIANT_KEY = {
    sensitive_skin: 'sensitive_skin',
    has_white_hack: 'white_hack',
    eco_only: 'eco_only',
    baby_household: 'baby_household',
    hard_water: 'hard_water',
    has_pet: 'has_pet',
  };
  for (const [prefKey, varKey] of Object.entries(PREF_TO_VARIANT_KEY)) {
    if (prefs[prefKey] && variants[varKey]) {
      html += `<div class="variant-callout ${varKey}"><strong>${variantLabels[varKey] || varKey}</strong>${escapeHtml(variants[varKey])}</div>`;
    }
  }

  prodWrap.innerHTML = html;
}

function nextStep() {
  if (!state.stainTreatment) return;
  const t = state.stainTreatment;
  let totalSteps;
  if (t._source === 'v3') {
    const surface = state.stainSurface;
    totalSteps = (t.surfaces?.[surface]?.steps || []).length;
  } else {
    totalSteps = (t.steps || []).length;
  }
  state.stainStepIndex++;
  if (state.stainStepIndex >= totalSteps) finishTreatment();
  else renderStep();
}
function prevStep() {
  if (state.stainStepIndex > 0) {
    state.stainStepIndex--;
    renderStep();
  } else {
    // On step 1: V3 → back to surface picker; legacy → back to result card.
    hideAll(['stain-treatment']);
    if (state.stainTreatment?._source === 'v3' && state.stainTreatment.surfaces) {
      showSurfacePicker();
    } else if (state.stainScan) {
      renderStainResult(state.stainScan);
    }
  }
}

function finishTreatment() {
  const t = state.stainTreatment;
  if (t) {
    state.stainHistory.unshift({
      id: 'sh_' + Math.random().toString(36).slice(2, 9),
      stainName: t.name,
      category: t.category,
      finishedAt: Date.now(),
    });
    state.stainHistory = state.stainHistory.slice(0, 20);
    save(LS.stainHistory, state.stainHistory);
  }
  hideAll(['stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-surface-picker']);

  // V3 → completion card. Pro tip + expectation + science already shown on
  // the Most likely card; here we surface only the Alt method ("if the
  // primary plan didn't fully work, here's the next thing to try").
  if (t?._source === 'v3') {
    const body = document.getElementById('stain-pro-tip-body');
    let html = '';
    if (t.alt_method) {
      html += `<div class="pro-tip-block alt-method"><h4>🔁 Alt method</h4><p>${escapeHtml(t.alt_method)}</p></div>`;
    }
    body.innerHTML = html;
    document.getElementById('stain-pro-tip-card').style.display = 'block';
    renderStainHistory();
    return;
  }

  // Legacy: original verify-photo card
  document.getElementById('stain-final').style.display = 'block';
  document.getElementById('stain-verify-result').style.display = 'none';
  document.getElementById('stain-verify-result').innerHTML = '';
  renderStainHistory();
}

// Called from the V3 pro-tip card when the user wants to verify with an after-photo.
function continueToVerify() {
  hideAll(['stain-pro-tip-card']);
  document.getElementById('stain-final').style.display = 'block';
  document.getElementById('stain-verify-result').style.display = 'none';
  document.getElementById('stain-verify-result').innerHTML = '';
}

// Convenience alias used by the V3 spec's test scenarios.
function saveUserPrefs(prefs) {
  state.prefs = { ...(state.prefs || {}), ...(prefs || {}) };
  save(LS.prefs, state.prefs);
  restorePrefsUI();
  if (state.stainTreatment && document.getElementById('stain-treatment')?.style.display === 'block') {
    renderStep();
  }
  return state.prefs;
}

// --- After photo + verification ---
function onStainAfterChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    verifyStainRemoved(state.stainImageDataUrl, dataUrl, state.stainTreatment?.name || 'the stain');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

async function verifyStainRemoved(beforeUrl, afterUrl, stainName) {
  const key = localStorage.getItem(LS.key);
  if (!key) return toast('Add your OpenAI API key first');
  const model = localStorage.getItem(LS.model) || 'gpt-4o-mini';
  const wrap = document.getElementById('stain-verify-result');
  wrap.style.display = 'block';
  wrap.innerHTML = '<div style="text-align:center;padding:14px"><span class="spinner"></span> Comparing photos…</div>';

  const sys = `You compare two photos of the same fabric. The user attempted to remove a "${stainName}" stain. Return STRICT JSON:
{
  "removed": true | false,
  "residue_visible": true | false,
  "recommendation": "<one warm, encouraging sentence. If residue is visible, suggest a gentle next pass — never imply failure. If gone, celebrate briefly without gushing. Never compare to ideal homes.>"
}
Output JSON only.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [
            { type: 'text', text: 'Before photo first, then after photo. Did the treatment work?' },
            { type: 'image_url', image_url: { url: beforeUrl, detail: 'low' } },
            { type: 'image_url', image_url: { url: afterUrl, detail: 'low' } },
          ]},
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });
    if (!res.ok) throw new Error('OpenAI error ' + res.status);
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    const icon = parsed.removed ? '✨' : '🔁';
    // Render the side-by-side before/after so the user can see the comparison.
    const beforeAfter = (beforeUrl && afterUrl) ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0">
        <div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Before</div>
          <img src="${beforeUrl}" alt="before" style="width:100%;border-radius:12px;border:1px solid var(--border)" />
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">After</div>
          <img src="${afterUrl}" alt="after" style="width:100%;border-radius:12px;border:1px solid var(--border)" />
        </div>
      </div>` : '';
    wrap.innerHTML = `
      <div style="text-align:center;font-size:28px">${icon}</div>
      <p style="text-align:center;margin-top:6px">${escapeHtml(parsed.recommendation || 'Take a look — you know best.')}</p>
      ${beforeAfter}
      <div class="row" style="margin-top:8px">
        ${!parsed.removed ? `<button class="btn" onclick="startTreatment()">Run another pass</button>` : ''}
        <button class="btn ${parsed.removed ? '' : 'secondary'} press-gold" onclick="this.classList.add('pressed'); setTimeout(showHappyQuestion, 200)">Finish</button>
      </div>
    `;
  } catch (err) {
    console.error(err);
    wrap.innerHTML = `
      <p style="color:var(--muted);text-align:center">Couldn't compare automatically. Trust your eyes.</p>
      <button class="btn" onclick="showHappyQuestion()" style="margin-top:8px">Finish</button>
    `;
  }
}

// --- History list (Recents section was removed from the UI) ---
function renderStainHistory() { /* no-op: Recents section removed */ }

// --- Happy-question flow (shown after Finish or after verify completes) ---
function showHappyQuestion() {
  hideAll([
    'stain-cause-prompt', 'stain-name-input-card', 'stain-countdown-card',
    'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final',
    'stain-surface-picker', 'stain-pro-tip-card',
    'stain-happy-yes', 'stain-happy-no', 'stain-happy-thanks',
  ]);
  const card = document.getElementById('stain-happy-question');
  if (card) card.style.display = 'block';
}

function happyAnswer(answer) {
  hideAll([
    'stain-happy-question', 'stain-happy-yes', 'stain-happy-no', 'stain-happy-thanks',
    'stain-final', 'stain-pro-tip-card', 'stain-surface-picker',
  ]);
  if (answer === 'yes') {
    const yes = document.getElementById('stain-happy-yes');
    if (yes) yes.style.display = 'block';
  } else {
    const no = document.getElementById('stain-happy-no');
    if (no) no.style.display = 'block';
    setTimeout(() => document.getElementById('stain-feedback-text')?.focus(), 60);
  }
}

function submitFeedback(skipped) {
  const fb = document.getElementById('stain-feedback-text');
  const text = fb ? (fb.value || '').trim() : '';
  if (!skipped && text) {
    const list = load(LS.stainFeedback, []);
    list.unshift({
      stain: state.stainTreatment?.name || null,
      category: state.stainTreatment?.category || null,
      feedback: text,
      at: Date.now(),
    });
    save(LS.stainFeedback, list.slice(0, 100));
  }
  hideAll(['stain-happy-no']);
  const thanks = document.getElementById('stain-happy-thanks');
  if (thanks) thanks.style.display = 'block';
}

function resetStainFlow() {
  state.stainTreatment = null;
  state.stainStepIndex = 0;
  state.stainScan = null;
  state.stainImageDataUrl = null;
  state.stainSurface = null;
  state.surfaceFromAI = null;
  localStorage.removeItem(LS.lastStainScan);
  hideAll([
    'stain-cause-prompt', 'stain-name-input-card', 'stain-countdown-card',
    'stain-confident', 'stain-needs-category', 'stain-treatment', 'stain-final',
    'stain-surface-picker', 'stain-pro-tip-card', 'stain-group-stains',
    'stain-happy-question', 'stain-happy-yes', 'stain-happy-no', 'stain-happy-thanks',
  ]);
  // Make sure the hero (photo CTA + picker grid) is visible again
  const hero = document.getElementById('laundry-hero');
  if (hero) hero.style.display = 'block';
  const input = document.getElementById('stain-typed-input');
  if (input) input.value = '';
  const fb = document.getElementById('stain-feedback-text');
  if (fb) fb.value = '';
  // Clear photo preview
  const preview = document.getElementById('stain-preview-img');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  const placeholder = document.getElementById('stain-upload-placeholder');
  if (placeholder) placeholder.style.display = 'block';
  // Re-show the gallery/camera buttons
  const uploadBtns = document.getElementById('stain-upload-buttons');
  if (uploadBtns) uploadBtns.style.display = 'flex';
}

function hideAll(ids) {
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
}

// --- Utils ---
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function formatMinutes(total) {
  if (total < 60) return total + ' min';
  const m = Math.floor(total / 60), s = total % 60;
  return `${m}:${s.toString().padStart(2,'0')}`;
}
// Friendly seconds → "30 sec" / "5 min" / "1 hr" / "overnight"
function formatSeconds(sec) {
  if (!sec || sec < 1) return '—';
  if (sec >= 6 * 3600) return 'overnight';
  if (sec >= 3600) {
    const h = Math.round(sec / 3600);
    return `${h} hr${h > 1 ? 's' : ''}`;
  }
  if (sec >= 60) {
    const m = Math.round(sec / 60);
    return `${m} min`;
  }
  return `${Math.round(sec)} sec`;
}
