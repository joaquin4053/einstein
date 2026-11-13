// Author analysis: weights and thresholds in one place (see docs/authors.md).

export const AUTHOR_CONFIG = {
  /** Most-cited works of the run's scope (topic × methods, year filter) whose authors become candidates. */
  sampleWorks: 60,
  /** Works with more authors are left out of the candidate sample (consortium papers would flood it). */
  maxAuthorsPerWork: 30,
  /** Candidates (by works and citations in the sample) whose topic-wide statistics are queried. */
  candidates: 25,
  /** Below this many key authors in topic × methods, the analysis widens to the topic alone. */
  minAuthorsBeforeWidening: 3,

  /**
   * score = works            · log(1 + topic works)              / log(1 + max)
   *       + citationsPerYear · log(1 + Σ citations / age of work) / log(1 + max)
   *       + hIndex           · h-index / max h-index
   * Each part is scaled to the strongest candidate, so scores run from 0 to 1 within a topic.
   * Citations per year of age instead of raw citations, so a 2005 paper does not beat a strong
   * 2022 one just by having had more time. Logs because output and citations are heavy-tailed.
   * The h-index covers the whole career, not the topic, so it weighs least.
   */
  weights: { works: 0.45, citationsPerYear: 0.4, hIndex: 0.15 },

  /**
   * How much knowledge each author added to this answer – bubble size, ranking and the "share" percentage.
   * Each work the answer read is worth answerWork + claimWork per claim that cites it, and that worth is
   * split equally among the work's authors (fractional counting: a 30-author paper gives each author 1/30,
   * a solo paper gives its author everything). Summed per author and scaled to the strongest one; the topic
   * score only adjusts it by up to ±topicWeight/2, so it cannot lift a minor contributor to the top.
   * Authors who wrote none of the answer's works get outsideAnswer · score (small bubbles).
   * The shares shown are each author's part of the total, so they add up to 100%.
   */
  contribution: { topicWeight: 0.25, outsideAnswer: 0.08, claimWork: 1, answerWork: 1 },

  /** Only authors with at least this many works on the topic count as substantial contributors (unless they wrote works of the answer). */
  minTopicWorks: 2,
  /** Authors below this score are not shown. */
  minScore: 0.25,
  /** Bubbles shown by default, and at most ("show all"). */
  topN: 12,
  maxN: 15,
  /** Papers listed per author in the bubble's detail card. */
  topWorksPerAuthor: 3,
  /** Co-authors listed per author (from the sampled works). */
  coAuthorsPerAuthor: 5,

  /** Results are cached in memory per scope (topic, methods, year filter). */
  cacheTtlMs: 6 * 60 * 60 * 1000,
  cacheEntries: 200,
} as const;
