// Lists come from Christian's Nov 20, 2025 email and the Oct 28 call.
// Anything marked DRAFT is a placeholder until Christian sends the written protocol.

export const DIAGNOSES = [
  'Respiratory', 'Pink Eye', 'Hoof Rot', 'Bull', 'Abscess',
  'Water Belly', 'Bloat', 'Injury', 'Death', 'Other',
];

export const HR = ['HR1 Draxxin', 'HR2 Baytril', 'HR3 NuFlor / Bio-Mycin'];
export const CNT = 'Check No Treatment';
export const TREATMENTS = [
  ...HR, 'LR1 Bio-Mycin', 'Castration – Bio-Mycin', 'Tube', CNT, 'Other',
];

export const CAUSES = ['Wolf', 'Bear', 'Sickness', 'Unknown', 'Other'];
export const PREDATOR_CAUSES = ['Wolf', 'Bear'];

export const TEMP_THRESHOLD = 103.5; // °F — below this, no medication (Oct 28 call)

export const DEFAULT_COLORS = ['blue', 'green', 'yellow', 'red', 'orange', 'white', 'pink', 'purple'];

export const COLOR_HEX = {
  blue: '#2563eb', green: '#16a34a', yellow: '#eab308', red: '#dc2626',
  orange: '#ea580c', white: '#f8fafc', pink: '#ec4899', purple: '#7c3aed',
  black: '#111827', gray: '#6b7280', brown: '#92400e', lime: '#84cc16',
  teal: '#0d9488', tan: '#d2b48c',
};

// What the crew might say out loud. Christian is sending the real nickname list;
// admins can add more in Settings without a code change.
export const TREATMENT_ALIASES = {
  'HR1 Draxxin': ['hr1', 'hr 1', 'hr one', 'h r 1', 'h r one', 'draxxin', 'draxin', 'drax in', 'drax', 'drachs'],
  'HR2 Baytril': ['hr2', 'hr 2', 'hr two', 'h r 2', 'h r two', 'baytril', 'bay trill', 'bay tril', 'baytrill', 'bay trail'],
  'HR3 NuFlor / Bio-Mycin': ['hr3', 'hr 3', 'hr three', 'h r 3', 'h r three', 'nuflor', 'nu flor', 'new flor', 'newflor', 'new floor'],
  'LR1 Bio-Mycin': ['lr1', 'lr 1', 'lr one', 'l r 1', 'l r one', 'bio mycin', 'biomycin', 'bio-mycin', 'bio mice in'],
  'Castration – Bio-Mycin': ['castration', 'castrated', 'castrate', 'cut him', 'cut'],
  'Tube': ['tubed', 'tubing', 'tube'],
  [CNT]: ['check no treatment', 'check no treat', 'no treatment', 'check only', 'just a check', 'cnt', 'no treat', 'nothing'],
};

export const DIAGNOSIS_ALIASES = {
  'Respiratory': ['respiratory', 'resp', 'pneumonia', 'lungs', 'breathing'],
  'Pink Eye': ['pink eye', 'pinkeye', 'pink i'],
  'Hoof Rot': ['hoof rot', 'foot rot', 'footrot', 'hoofrot'],
  'Bull': ['bull', 'stag'],
  'Abscess': ['abscess', 'abcess', 'absess'],
  'Water Belly': ['water belly', 'waterbelly'],
  'Bloat': ['bloat', 'bloated', 'bloating'],
  'Injury': ['injury', 'injured', 'hurt'],
};

export const CAUSE_ALIASES = {
  'Wolf': ['wolf', 'wolves', 'wolfs'],
  'Bear': ['bear', 'bears', 'bare'],
  'Sickness': ['sickness', 'sick', 'disease', 'illness'],
  'Unknown': ['unknown', "don't know", 'dont know', 'not sure'],
};

export const DEATH_WORDS = ['dead', 'death', 'died', 'killed', 'kill', 'carcass'];

export const COLOR_ALIASES = {
  blue: ['blue', 'blew'], green: ['green'], yellow: ['yellow'], red: ['red', 'read'],
  orange: ['orange'], white: ['white'], pink: ['pink'], purple: ['purple'],
  black: ['black'], gray: ['gray', 'grey'], brown: ['brown'], lime: ['lime'],
  teal: ['teal'], tan: ['tan'],
};
