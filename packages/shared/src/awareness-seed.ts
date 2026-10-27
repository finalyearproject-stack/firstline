/**
 * Seed health-awareness content (spec s11).
 *
 * Lives in the shared package because two consumers need it: the API seeds it into the
 * database, and the CHW app bundles it so a freshly installed device has awareness
 * content available before it has ever reached the network.
 *
 * TRANSLATION STATUS
 * ------------------
 * The English text is written for a CHW to read aloud to a patient. The Luganda ("lg")
 * entries are DRAFT translations included so the multi-language mechanism can be
 * demonstrated end to end. They have not been reviewed by a native speaker or by a
 * health educator, and they are marked `reviewed: false`. Before any field use, each
 * translation must be reviewed and the flag set by the responsible health authority.
 * The same applies to the audio: `audioPath` points at a file the deployment supplies;
 * no recorded audio ships with this repository.
 */

export interface AwarenessSeed {
  id: string;
  title: string;
  language: string;
  category: string;
  summary: string;
  body: string;
  audioPath: string | null;
  version: number;
  active: boolean;
  /** False until a qualified reviewer has approved the wording in that language. */
  reviewed: boolean;
}

export const AWARENESS_CATEGORIES = [
  'Hypertension',
  'Diabetes',
  'Maternal health',
  'Child health',
  'Malaria',
  'Nutrition',
  'Disease prevention',
] as const;

export const AWARENESS_SEED: AwarenessSeed[] = [
  {
    id: '8f1c2a40-0001-4000-8000-000000000001',
    title: 'Understanding high blood pressure',
    language: 'en',
    category: 'Hypertension',
    summary: 'What high blood pressure is, why it is dangerous, and what the patient can do.',
    body: [
      'High blood pressure means the blood is pushing too hard against the walls of the blood vessels. Most people who have it feel completely well, which is why it is often called a silent condition.',
      '',
      'Why it matters: over time, high blood pressure can damage the heart, the brain and the kidneys. It is one of the main causes of stroke.',
      '',
      'What the patient can do:',
      '- Use less salt in cooking and do not add salt at the table.',
      '- Eat more vegetables and fruit where these are available.',
      '- Walk or stay active for about thirty minutes on most days.',
      '- Avoid tobacco, and limit alcohol.',
      '',
      'Important: if a health worker has given the patient medicine for blood pressure, they must keep taking it even when they feel well. Feeling well does not mean the blood pressure has returned to normal.',
      '',
      'Come back to the health worker if there is a bad headache that does not go away, blurred vision, chest pain, or difficulty breathing.',
    ].join('\n'),
    audioPath: '/audio/en/hypertension.mp3',
    version: 1,
    active: true,
    reviewed: true,
  },
  {
    id: '8f1c2a40-0001-4000-8000-000000000002',
    title: 'Okutegeera puleesa y\'omusaayi eya waggulu',
    language: 'lg',
    category: 'Hypertension',
    summary: 'DRAFT TRANSLATION - awaiting review. Basic hypertension awareness in Luganda.',
    body: [
      '[DRAFT TRANSLATION - NOT YET REVIEWED]',
      '',
      'Puleesa y\'omusaayi eya waggulu kitegeeza nti omusaayi gukuba n\'amaanyi mangi mu misuwa. Abantu abasinga abalina obulwadde buno tebalina bubonero bwonna, era kyekiva buyitibwa obulwadde obusirikiridde.',
      '',
      'Lwaki kikulu: puleesa eya waggulu esobola okwonoona omutima, obwongo n\'ensigo mu bbanga eddene.',
      '',
      'Omulwadde ky\'asobola okukola:',
      '- Kendeeza ku munnyo mu mmere.',
      '- Lya enva endiirwa n\'ebibala ng\'ebiriwo.',
      '- Tambula essaawa nga ekitundu buli lunaku.',
      '- Weewale okunywa sigala.',
      '',
      'Ekikulu: omusawo bw\'akuwa eddagala, linywe buli lunaku ne bw\'oba owulira bulungi.',
      '',
      'Ddayo eri omusawo bw\'oba olina omutwe ogulumya nnyo, obutalaba bulungi, okulumwa mu kifuba, oba obuzibu mu kussa.',
    ].join('\n'),
    audioPath: '/audio/lg/puleesa-ya-waggulu.mp3',
    version: 1,
    active: true,
    reviewed: false,
  },
  {
    id: '8f1c2a40-0001-4000-8000-000000000003',
    title: 'Living with diabetes',
    language: 'en',
    category: 'Diabetes',
    summary: 'Recognising the signs of diabetes and managing it day to day.',
    body: [
      'Diabetes means there is too much sugar in the blood because the body cannot use it properly.',
      '',
      'Signs to watch for: passing urine very often, being thirsty all the time, losing weight without trying, feeling very tired, and wounds that heal slowly.',
      '',
      'What the patient can do:',
      '- Eat regular meals rather than one very large meal.',
      '- Reduce sugary drinks and sweet foods.',
      '- Stay active.',
      '- Check the feet every day for cuts or sores, and report any that do not heal.',
      '',
      'Urgent: if the patient becomes confused, very drowsy, or is breathing deeply and quickly, they need to reach a health facility immediately.',
    ].join('\n'),
    audioPath: '/audio/en/diabetes.mp3',
    version: 1,
    active: true,
    reviewed: true,
  },
  {
    id: '8f1c2a40-0001-4000-8000-000000000004',
    title: 'Danger signs in pregnancy',
    language: 'en',
    category: 'Maternal health',
    summary: 'The signs during pregnancy that mean going to a facility without delay.',
    body: [
      'Most pregnancies are healthy. These signs, however, mean the woman should reach a health facility straight away, at any hour:',
      '',
      '- Bleeding from the vagina.',
      '- Severe headache, or blurred vision.',
      '- Severe pain in the stomach.',
      '- Fits or convulsions.',
      '- Fever with chills.',
      '- The baby moving much less than usual, or not at all.',
      '- Waters breaking before the expected time.',
      '',
      'During pregnancy: attend antenatal visits, sleep under a treated mosquito net, and take the supplements the facility provides.',
      '',
      'Plan ahead: agree now on which facility to use and how transport will be arranged, before it is urgently needed.',
    ].join('\n'),
    audioPath: '/audio/en/maternal-danger-signs.mp3',
    version: 1,
    active: true,
    reviewed: true,
  },
  {
    id: '8f1c2a40-0001-4000-8000-000000000005',
    title: 'Danger signs in young children',
    language: 'en',
    category: 'Child health',
    summary: 'When a child under five must be taken to a facility immediately.',
    body: [
      'Take a child under five to a health facility immediately if the child:',
      '',
      '- Cannot drink or breastfeed.',
      '- Vomits everything.',
      '- Has had fits or convulsions.',
      '- Is unusually sleepy or difficult to wake.',
      '- Is breathing fast, or the chest pulls in with each breath.',
      '',
      'For diarrhoea: give the child extra fluids and oral rehydration solution. Continue feeding. If the diarrhoea lasts more than three days, or there is blood in the stool, go to the facility.',
      '',
      'Prevention: complete the child’s immunisations, wash hands with soap, and use a treated mosquito net.',
    ].join('\n'),
    audioPath: '/audio/en/child-danger-signs.mp3',
    version: 1,
    active: true,
    reviewed: true,
  },
  {
    id: '8f1c2a40-0001-4000-8000-000000000006',
    title: 'Preventing and recognising malaria',
    language: 'en',
    category: 'Malaria',
    summary: 'How malaria spreads, how to prevent it, and when to seek testing.',
    body: [
      'Malaria is spread by the bite of an infected mosquito, mostly at night.',
      '',
      'Prevention:',
      '- Sleep under a treated mosquito net every night, including in the dry season.',
      '- Clear standing water around the house where mosquitoes breed.',
      '- Pregnant women should attend antenatal care for the preventive treatment offered there.',
      '',
      'Signs: fever, chills, headache, body aches, and tiredness.',
      '',
      'Important: malaria is confirmed by a test, not by the symptoms alone. Anyone with a fever should be tested at the health facility. Do not buy and take malaria medicine without a test.',
      '',
      'Go immediately if there are fits, confusion, very dark urine, or the person cannot stay awake.',
    ].join('\n'),
    audioPath: '/audio/en/malaria.mp3',
    version: 1,
    active: true,
    reviewed: true,
  },
  {
    id: '8f1c2a40-0001-4000-8000-000000000007',
    title: 'Feeding children well',
    language: 'en',
    category: 'Nutrition',
    summary: 'Practical feeding guidance for infants and young children.',
    body: [
      'For the first six months, breast milk alone is all a baby needs, with no water added.',
      '',
      'From six months, continue breastfeeding and begin adding other foods: start with soft, mashed food two to three times a day, and increase as the child grows.',
      '',
      'Make meals count: add beans, groundnuts, eggs, fish or meat where these are available, along with vegetables and fruit.',
      '',
      'Signs that need attention: the child is losing weight, is not growing, has swollen feet, or has become very thin. Bring the child to the health worker for assessment.',
      '',
      'During illness: keep feeding the child. Offer smaller amounts more often, and extra fluids.',
    ].join('\n'),
    audioPath: '/audio/en/nutrition.mp3',
    version: 1,
    active: true,
    reviewed: true,
  },
  {
    id: '8f1c2a40-0001-4000-8000-000000000008',
    title: 'Preventing the spread of illness',
    language: 'en',
    category: 'Disease prevention',
    summary: 'Everyday measures that reduce illness in the household.',
    body: [
      'Handwashing: wash hands with soap and clean water after using the toilet, after changing a baby, before preparing food, and before eating. This single habit prevents a great deal of illness.',
      '',
      'Water: drink water from a safe source. Where the source is not safe, boil the water or treat it as advised locally, and store it in a covered container.',
      '',
      'Food: cook food thoroughly and cover it. Wash fruit and vegetables with clean water.',
      '',
      'Coughs and colds: cover the mouth with the inside of the elbow when coughing.',
      '',
      'A cough lasting more than two weeks should be checked at the health facility.',
    ].join('\n'),
    audioPath: '/audio/en/prevention.mp3',
    version: 1,
    active: true,
    reviewed: true,
  },
];

/*
 * The second language is Luganda, which serves Uganda's Central Region. It is not a
 * national answer: Uganda has no single second language, and a deployment in the north
 * or east needs Acholi, Lango, Ateso or Lusoga instead. The list is data for exactly
 * that reason - adding a language is a content task, not a code change.
 */
export const AWARENESS_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'lg', label: 'Luganda' },
];
