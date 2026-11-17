// Lists come from Christian's Nov 20, 2025 email, the Oct 28 call and the Nov 10 feedback.
// Anything marked DRAFT is a placeholder until Christian sends the written protocol.

export const DIAGNOSES = [
  'Respiratory', 'Pink Eye', 'Hoof Rot', 'Bull Marked', 'Bull Castrated', 'Brainer', 'Abscess',
  'Water Belly', 'Bloat', 'Injury', 'Death', 'Other',
];

// Respiratory protocol steps. HR3 can be either drug.
export const HR_STEPS = [['HR1 Draxxin'], ['HR2 Baytril'], ['HR3 NuFlor', 'HR3 Bio-Mycin']];
export const HR = HR_STEPS.flat();
// Entries saved before NuFlor and Bio-Mycin were split still count as HR3.
export const LEGACY_TREATMENTS = { 'HR3 NuFlor / Bio-Mycin': 2 };
export const CNT = 'Check No Treatment';
export const TREATMENTS = [
  ...HR, 'LR1 Bio-Mycin', 'Castration – Bio-Mycin', 'Thiamine', 'Tube', CNT, 'Other',
];
// Treatments that can carry an admin-set dose.
export const DOSED_TREATMENTS = TREATMENTS.filter((t) => t !== CNT && t !== 'Other');

export const CAUSES = ['Wolf', 'Bear', 'Sickness', 'Unknown', 'Other'];
export const PREDATOR_CAUSES = ['Wolf', 'Bear'];

export const TEMP_THRESHOLD = 103.5; // °F — below this, no medication (Oct 28 call)
export const MOVED_WARN_MILES = 0.25; // warn if the phone moved this far but the pasture didn't change

export const DEFAULT_COLORS = ['blue', 'green', 'yellow', 'red', 'orange', 'white', 'pink', 'purple'];

export const COLOR_HEX = {
  blue: '#2563eb', green: '#16a34a', yellow: '#eab308', red: '#dc2626',
  orange: '#ea580c', white: '#f8fafc', pink: '#ec4899', purple: '#7c3aed',
  black: '#111827', gray: '#6b7280', brown: '#92400e', lime: '#84cc16',
  teal: '#0d9488', tan: '#d2b48c',
};

// What the crew might say out loud. Admins can add more in Settings without a code change.
export const TREATMENT_ALIASES = {
  'HR1 Draxxin': ['hr1', 'hr 1', 'h r 1', 'hr1 draxxin', 'draxxin', 'draxin', 'drax in', 'drax', 'drachs'],
  'HR2 Baytril': ['hr2', 'hr 2', 'h r 2', 'hr2 baytril', 'baytril', 'bay trill', 'bay tril', 'baytrill', 'bay trail'],
  'HR3 NuFlor': ['hr3 nuflor', 'hr 3 nuflor', 'hr3 new flor', 'hr 3 new floor', 'nuflor', 'nu flor', 'new flor', 'newflor', 'new floor', 'nuflo', 'new flow'],
  'HR3 Bio-Mycin': ['hr3 bio mycin', 'hr 3 bio mycin', 'hr3 biomycin', 'hr 3 biomycin', 'hr3 bio', 'hr 3 bio', 'h r 3 bio'],
  'LR1 Bio-Mycin': ['lr1', 'lr 1', 'l r 1', 'lr1 bio mycin', 'lr 1 bio mycin', 'bio mycin', 'biomycin', 'bio mice in', 'bio'],
  'Castration – Bio-Mycin': ['castration', 'castrated', 'castrate', 'cut him', 'cut'],
  'Thiamine': ['thiamine', 'thiamin', 'thymine', 'thighmine', 'vitamin b1', 'vitamin b 1', 'b1', 'b 1'],
  'Tube': ['tubed', 'tubing', 'tube'],
  [CNT]: ['check no treatment', 'check no treat', 'no treatment', 'check only', 'just a check', 'cnt', 'no treat', 'nothing'],
};
// Said "HR3" without naming the drug.
export const HR3_BARE = ['hr3', 'hr 3', 'h r 3'];

export const DIAGNOSIS_ALIASES = {
  'Respiratory': ['respiratory', 'resp', 'pneumonia', 'lungs', 'breathing'],
  'Pink Eye': ['pink eye', 'pinkeye', 'pink i'],
  'Hoof Rot': ['hoof rot', 'foot rot', 'footrot', 'hoofrot'],
  'Bull Marked': ['bull marked', 'marked bull', 'mark bull', 'bull mark', 'marked', 'mark him'],
  'Bull Castrated': ['bull castrated', 'castrated bull', 'bull cut', 'cut bull'],
  'Brainer': ['brainer', 'brainers', 'brain', 'brain ER', 'polio'],
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
export const NO_TAG_WORDS = ['no tag', 'notag', 'untagged', 'no tags', 'slick', 'tag missing', 'lost tag', 'missing tag'];
export const NO_TEMP_WORDS = ['no temp', 'no temperature', 'no temps', 'didn\'t temp', 'didnt temp', 'did not temp', 'not temped', 'didn\'t take temp', 'didnt take temp', 'did not take temp', 'didn\'t take a temp', 'didnt take a temp', 'skip temp', 'without temp', 'without a temp'];
export const SAME_PLACE_WORDS = ['same pasture', 'same place', 'same spot', 'same location', "haven't moved", 'havent moved', 'have not moved', 'still here'];

export const COLOR_ALIASES = {
  blue: ['blue', 'blew'], green: ['green'], yellow: ['yellow'], red: ['red', 'read'],
  orange: ['orange'], white: ['white'], pink: ['pink'], purple: ['purple'],
  black: ['black'], gray: ['gray', 'grey'], brown: ['brown'], lime: ['lime'],
  teal: ['teal'], tan: ['tan'],
};
