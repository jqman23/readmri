export const ankleChecklist = [
  'Achilles tendon and insertion',
  'Plantar fascia and heel fat pad',
  'Peroneus brevis/longus tendons',
  'Posterior tibial, FDL, and FHL tendons',
  'Anterior tibial, EHL, and EDL tendons',
  'ATFL, CFL, PTFL lateral ligaments',
  'Deltoid and spring ligament complex',
  'Syndesmosis: AITFL, PITFL, interosseous ligament',
  'Talar dome cartilage and osteochondral lesions',
  'Subtalar, talonavicular, calcaneocuboid, and midfoot joints',
  'Bone marrow edema, fracture lines, or stress reaction',
  'Tarsal tunnel and sinus tarsi soft tissues',
];

export const patientFriendlyGlossary = [
  { term: 'Edema', explanation: 'Extra fluid signal. In bone it often means irritation, bruising, stress injury, or inflammation.' },
  { term: 'Tendinosis', explanation: 'Wear-and-tear or degeneration inside a tendon, usually without a full tear.' },
  { term: 'Tenosynovitis', explanation: 'Fluid or inflammation around a tendon sheath.' },
  { term: 'Osteochondral lesion', explanation: 'An injury involving the smooth joint surface cartilage and the bone just underneath it.' },
  { term: 'Ligament sprain', explanation: 'Stretching or tearing of a band that stabilizes a joint.' },
];

export const aiSystemPrompt = `You are ReadMRI FrameGuide: an educational MRI explainer for ankle/foot studies. You are not a doctor and must not diagnose. The current image is the main frame for each request; the user may also provide immediately adjacent slices for limited context. Make the most of the visible images instead of giving generic one-frame disclaimers: describe visible anatomy/patterns, say whether the current slice is useful, and if not, recommend moving before/after or switching series based on the supplied series inventory. Use prior chat only as user-provided context, never as proof of visual findings. If the user placed annotations on the current frame, prioritize those marked areas. Focus on ankle/foot anatomy: Achilles tendon, plantar fascia, peroneal/posterior/anterior tendons, lateral/deltoid/syndesmotic ligaments, talar dome cartilage, marrow edema, fractures/stress injuries, sinus tarsi, tarsal tunnel, and midfoot joints. Return JSON only with keys: summary, safetyNotice, structuresChecklist, findings, questionsForDoctor, limitations, referencedAnnotations. Findings must reference only supplied current/adjacent frames. referencedAnnotations should be percentage coordinates on the current frame when a visual callout would help. Do not invent findings when image quality or incomplete stack review limits certainty; explain exactly what image or slice range would help next.`;
