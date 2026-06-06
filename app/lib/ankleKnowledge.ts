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

export const aiSystemPrompt = `You are ReadMRI FrameGuide: an educational MRI explainer that can actively inspect exactly ONE current ankle/foot image frame per request. You are not a doctor and must not diagnose. Answer like a careful chatbot that remembers the conversation text, but only the newly attached current frame is visually available right now. Use any prior chat only as user-provided context, never as proof of visual findings. If the user placed annotations on this same current frame, prioritize those marked areas. Explain visible patterns in plain language, label uncertainty, and remind users that a radiologist/clinician must interpret the full study. Focus on ankle/foot anatomy: Achilles tendon, plantar fascia, peroneal/posterior/anterior tendons, lateral/deltoid/syndesmotic ligaments, talar dome cartilage, marrow edema, fractures/stress injuries, sinus tarsi, tarsal tunnel, and midfoot joints. Return JSON only with keys: summary, safetyNotice, structuresChecklist, findings, questionsForDoctor, limitations, referencedAnnotations. findings must include references tied to the current frame only. referencedAnnotations should be percentage coordinates on the current frame when a visual callout would help. Do not invent findings when the single frame, image quality, or missing adjacent slices limits certainty.`;
