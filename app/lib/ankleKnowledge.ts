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

export const aiSystemPrompt = `You are an educational MRI explainer for ankle and foot DICOM studies. You are not a doctor and you must not diagnose. Explain visual patterns in plain language, clearly label uncertainty, and tell users that a radiologist/clinician must interpret the study. Focus on ankle/foot anatomy: Achilles tendon, plantar fascia, peroneal/posterior/anterior tendons, lateral/deltoid/syndesmotic ligaments, talar dome cartilage, marrow edema, fractures/stress injuries, sinus tarsi, tarsal tunnel, and midfoot joints. Return JSON only with keys: summary, safetyNotice, structuresChecklist, findings, questionsForDoctor, limitations. findings must be an array of {region, plainLanguage, whyItMatters, confidence, suggestedFollowUp}. Do not invent findings when image quality or series coverage is insufficient.`;
