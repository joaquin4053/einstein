# Key authors (author graph)

Every research run ranks the authors behind its answer and shows them in the evidence panel's **Authors** tab,
drawn like the evidence graph:

- **Ranking first**: "Who contributed most to this answer" – the top author in a sentence and a ranked list
  with each author's share (the shares add up to 100 %).
- **Graph**: the topic keyword in the centre (amber, as in the evidence graph), one circle per author with the
  name underneath. Circle **area** ∝ the author's share (the share is printed in the bigger circles; the top
  three are dark, the rest light). **Distance** from the centre = how recent the author's works are (median
  year; newer closer, dashed rings mark the years). Grey lines join authors to the topic, blue lines join
  co-authors, a blue ring marks authors whose works the answer's claims cite.

All data – works, authors, co-authors – comes from SemOpenAlex through its MCP server; each author links to their
page in the SemOpenAlex Explorer.

## Pipeline

The **Author Analyst** agent runs in every run, after the answer is out (`runAuthors` in
`lib/agents/pipeline.ts`, called by `app/api/research/route.ts`; logic in `lib/kg/authors.ts`). The answer is
streamed first, the ranking follows as an `authors` event, so the MCP server never gets the retrieval and the
author queries at the same time. It fails soft: the report never depends on it.

1. **Topic**: the Retriever's scope – the topic concept, the method concepts and the year filter, after any
   widening the Retriever did.
2. **Works**: the `sampleWorks` most cited works of that scope (`topWorks`, with its timeout fallback).
3. **Authors**: author count per work first; works with more than `maxAuthorsPerWork` authors (consortia) are
   left out. Then the authors of the remaining works.
4. **Identity**: the SemOpenAlex author IRI, as in the SemOpenAlex Explorer. Authors are never merged by name.
5. **Candidates**: the `candidates` authors with the most works (then citations) in the sample.
6. **Topic-wide statistics** per author, counted in the KG over the whole scope (not just the sample): works,
   citations, citations per year of age. Plus name, h-index and last known institution.
7. **Score, filter, rank**, see below. The top `topN` are shown, up to `maxN` behind "Show all".
8. **Co-authors**: per key author, the `coAuthorsPerAuthor` authors who share most sampled works with them (names
   via `foaf:name`), and the pairs of key authors who share works (the dashed lines).
9. If topic × methods yields fewer than `minAuthorsBeforeWidening` key authors, the analysis is repeated for the
   topic alone and marked as widened.

### MCP tools used

All requests go through `getSource()` (`lib/kg/source.ts`) – the SemOpenAlex MCP server:

| Tool | Used for |
|---|---|
| `entity_lookup`, `keyword_search` | Linking the question's terms to `soa:Concept`s (Planner/Retriever, and `/api/authors`) |
| `execute_sparql_query` | Everything else: works, authors, co-authors, statistics, profile data (paged past the 20-row preview) |
| `describe_entity` | Not used by the author analysis |

SPARQL templates are in `lib/kg/queries.ts` (`authorCounts`, `workAuthors`, `authorNames`, `authorTopicStats`,
`authorDetails`, `titles`). They use only ontology terms: `dct:creator` (work → `soa:Author`), `foaf:name`,
`bido:h-index`, `org:memberOf` (last known `soa:Institution`), `soa:citedByCount`,
`soa:hasConcept`, `fabio:hasPublicationYear`. The ontology itself is unchanged, and the score is never written
to the evidence graph or the RDF export.

## Contribution (bubble size and share)

Who added the most knowledge to this answer:

```
worth of a work  = 1 (the answer read it) + 1 per claim that cites it
answer credit    = Σ over the author's works in the answer: worth / number of authors of that work
contribution     = answer credit / best answer credit · (0.75 + 0.25 · topic score)
                   (authors with no work in the answer: 0.08 · topic score)
share            = contribution / Σ contributions of all listed authors   → the shares add up to 100 %
```

- **Fractional counting**: a paper's worth is split among its authors, so a solo author of a key paper
  outweighs each of 25 consortium members.
- **Claims count**: a paper that backs several claims is worth more than one the answer only read.
- **Topic score only adjusts** (±12.5 %), so it cannot lift a minor contributor to the top or flatten the ranking.
- Authors who wrote exactly the same papers get the same answer credit; their topic statistics break the tie.

Circle radius ∝ √share between the smallest and the biggest contributor, so areas compare like the shares. Weights: `contribution` in `lib/config/authors.ts`.

## Viewer

Both graphs share one viewer style (`components/GraphToolbar.tsx`): full screen (top right), zoom in/out, fit;
the evidence graph also re-arranges and saves a PNG, and its legend hides or shows node kinds. The author graph
pans by dragging the background and zooms with the wheel in full screen (ctrl + wheel in the panel). The evidence
panel can be widened (handle on its left edge), its graph made taller (handle under the graph), or opened full
screen (header button, Esc to leave); sizes are remembered in the browser.

## Score

```
score = 0.45 · log(1 + topic works)       / log(1 + max)
      + 0.40 · log(1 + citations per year) / log(1 + max)
      + 0.15 · h-index / max h-index
```

- **Topic works** measure sustained contribution; citations alone would favour one-hit papers.
- **Citations per year of age** (Σ citations / (2026 − year), at least 1) instead of raw citations, so older
  authors do not win merely by having had more time. Raw citations are still shown.
- **h-index** is career-wide, not topic-specific, so it weighs least and is optional (missing = 0).
- **Logs** because output and citations are heavy-tailed. Each part is scaled to the best candidate, so scores
  run from 0 to 1 *within a topic*; they are not comparable across topics.
- **Filter**: at least `minTopicWorks` works on the topic and a score of at least `minScore`.

## Config

`lib/config/authors.ts` holds weights, thresholds, sample sizes, `topN`/`maxN` and the cache settings.

## Testing the MCP queries

With MCP credentials in `.env.local` and `npm run dev`:

```bash
curl "http://localhost:3000/api/authors?topic=Alzheimer's%20disease&method=Deep%20learning&from=2018"
```

The answer holds the resolved concepts, the ranking, the run time and every SPARQL query sent (with the MCP
paging notes). In the app, the agent trace shows the same queries under **Author Analyst**.

## Known limitations

- **Disambiguation**: OpenAlex's author clustering is automatic. One person split over several author IDs stays
  split, and wrongly merged clusters stay merged. Name-based merging is deliberately not done.
- **Co-authors** are counted on the sampled (most cited) works, not on all of an author's works.
- **Candidates come from the most cited works**: a prolific author whose papers are all moderately cited can be
  missed. Raising `sampleWorks` widens the net at the cost of more queries.
- **Consortium papers** (> `maxAuthorsPerWork` authors) are left out of the sample, so their authors only count
  if they also appear on smaller papers. Their topic-wide counts still include them.
- **Topic mapping**: the question is mapped to concepts by the Planner and `entity_lookup` / `keyword_search` /
  label search; the main topic concept is used. Topic × methods that turns out too narrow is widened to the topic
  alone. Concept tags in OpenAlex are assigned automatically.
- **Fallbacks**: works → authors via `dct:creator`, else via `soa:hasAuthorship`/`soa:hasAuthor`. When the
  topic-wide counts fail or time out, an author's works in the sample are used instead (a lower bound) and one
  work among the most cited ones is enough. Every workaround is listed in the trace, and in the Authors tab when
  nothing is found.
- **Performance**: a run adds about `sampleWorks/20` + a few dozen small, author-anchored queries, sent at most
  three at a time (`MCP_MAX_CONCURRENT` in `lib/kg/source.ts`). If a statistics batch times out, the sample counts are used and the result is marked approximate.
- **Caching**: results are cached in memory per scope (`cacheTtlMs`, `cacheEntries`). On serverless hosts the cache
  only lives as long as a warm function instance; empty results are not cached.
- **Missing data**: name, institution and h-index are optional; the UI shows "–" or a note instead.
- **Institution** is the author's last known one (`org:memberOf`), not necessarily the one at the time of the works.

## Later: more profile links

`TopicAuthor.profileLinks` has `semOpenAlex` (the Explorer page) and the reserved `googleScholar` and `linkedIn`. Before adding LinkedIn: its official API only allows looking up other
people with partner access, and third-party LinkedIn tools usually scrape, which breaks LinkedIn's terms of
use – clear this legally first.
