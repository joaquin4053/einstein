// Rule-based vocabulary used in demo mode (no LLM key) and as a fallback when
// the LLM answer can't be parsed. Patterns run over title + abstract.

export const METHOD_PATTERNS: [string, RegExp][] = [
  ["Convolutional neural network", /\b(convolutional (neural )?networks?|CNNs?|FCNs?|ResNet|VGG|DenseNet|U-?Net)\b/i],
  ["Transfer learning", /\b(transfer learning|pre-?trained)\b/i],
  ["Transformer", /\b(transformers?|BERT|attention mechanism|vision transformer|ViT)\b/i],
  ["Recurrent neural network", /\b(LSTM|GRU|recurrent neural|RNNs?)\b/i],
  ["Support vector machine", /\b(support vector|SVMs?)\b/i],
  ["Random forest", /\brandom forests?\b/i],
  ["Gradient boosting", /\b(XGBoost|gradient boost\w*|LightGBM|CatBoost)\b/i],
  ["Generative adversarial network", /\b(generative adversarial|GANs?)\b/i],
  ["Autoencoder", /\b(auto-?encoders?|VAE)\b/i],
  ["Graph neural network", /\b(graph neural|GNNs?|graph convolutional)\b/i],
  ["Large language model", /\b(large language models?|LLMs?|GPT-?\d?|ChatGPT)\b/i],
  ["Logistic regression", /\blogistic regression\b/i],
  ["Ensemble learning", /\bensemble\b/i],
  ["Explainable AI", /\b(explainab\w+|interpretab\w+|SHAP|Grad-?CAM|XAI)\b/i],
  ["Federated learning", /\bfederated learning\b/i],
  ["Artificial neural network", /\b(artificial neural networks?|ANNs?)\b/i],
  ["Deep neural network", /\b(deep neural networks?|DNNs?|multilayer perceptrons?|MLPs?)\b/i],
  ["Clustering", /\b(k-?means|clustering|unsupervised)\b/i],
];

export const TASK_PATTERNS: [string, RegExp][] = [
  ["Diagnosis", /\b(early (diagnosis|detection|identification)|diagnos\w+|detection)\b/i],
  ["MCI conversion prediction", /\b(mild cognitive impairment|MCI|conversion|converters?)\b/i],
  ["MRI analysis", /\b(MRI|magnetic resonance|structural imaging|neuroimaging)\b/i],
  ["PET imaging", /\b(PET|positron emission)\b/i],
  ["EEG analysis", /\b(EEG|electroencephalo\w+)\b/i],
  ["Speech & language markers", /\b(speech|spoken|voice|linguistic)\b/i],
  ["Biomarker discovery", /\b(biomarkers?|amyloid|tau|CSF|plasma)\b/i],
  ["Drug discovery", /\b(drug (discovery|repurpos\w+|design)|therapeutic targets?)\b/i],
  ["Brain segmentation", /\bsegment\w*\b/i],
  ["Genetic risk analysis", /\b(genetic|genomic\w*|APOE|GWAS|gene expression)\b/i],
  ["Disease progression modelling", /\b(progression|longitudinal|trajector\w+|prognos\w+)\b/i],
  ["Classification", /\b(multi-?class|classification|classif\w+)\b/i],
];

/** Generic AI wording in a question → SemOpenAlex method concepts to search. */
export const GENERIC_METHOD_TERMS: [RegExp, string[]][] = [
  [/\b(AI|artificial intelligence|AI models?)\b/i, ["Artificial intelligence", "Machine learning", "Deep learning"]],
  [/\bmachine learning\b/i, ["Machine learning"]],
  [/\bdeep learning\b/i, ["Deep learning"]],
  [/\bneural networks?\b/i, ["Artificial neural network"]],
  [/\b(large language models?|LLMs?)\b/i, ["Language model"]],
  [/\bcomputer vision\b/i, ["Computer vision"]],
  [/\b(natural language processing|NLP)\b/i, ["Natural language processing"]],
];

export const STOPWORDS = new Set(
  `how have has been applied apply used use which what related concepts topics subfields most commonly
  associated with these those works research since after from the and or of in on to for a an is are
  were was be by do does did that this models model methods method field fields studies study papers
  between across about into over than more within their its it they them who whom when where why
  much many know known now currently today there`
    .split(/\s+/)
    .filter(Boolean),
);

export function matchAll(patterns: [string, RegExp][], text: string): string[] {
  return patterns.filter(([, re]) => re.test(text)).map(([label]) => label);
}

/**
 * Maps a free-form label (e.g. from the LLM) onto the shared vocabulary, so
 * "FCN", "CNN" and "Convolutional neural network" become one node and their
 * evidence adds up. Unknown labels are kept as they are.
 */
export function canonical(label: string, kind: "method" | "task", topic: string): string {
  let l = label.trim();
  if (kind === "task") {
    // "Alzheimer's disease classification" → "classification"
    const words = topic
      .toLowerCase()
      .replace(/[’']s\b/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Only a leading topic phrase: "Weather and climate modelling" stays intact.
    const lead = new RegExp(`^((${[...words, "disease"].join("|")})(['’]s)?\\s+)+`, "i");
    l = l.replace(lead, "");
    l = l.replace(/\s+/g, " ").trim() || label.trim();
  }
  const hit = (kind === "method" ? METHOD_PATTERNS : TASK_PATTERNS).find(([, re]) => re.test(l));
  return hit ? hit[0] : l.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

export const METHOD_NAMES = METHOD_PATTERNS.map(([n]) => n);
export const TASK_NAMES = TASK_PATTERNS.map(([n]) => n);
