# Einstein – rules for working on this repo

- **All knowledge-graph access goes through `getSource()` in `lib/kg/source.ts`.** With MCP credentials set, that is
  the SemOpenAlex MCP server: SPARQL via `execute_sparql_query` (paged past its 20-row preview), concept linking via
  `entity_lookup` and `keyword_search`, entity context via `describe_entity`. There is no other route: do not add the
  public SPARQL endpoint, `fetch` SemOpenAlex directly, or add any other data tool. Without MCP credentials runs fail.
- **One exception: the web-search fallback.** When a run fails on SemOpenAlex (`KgUnavailable` in
  `lib/agents/pipeline.ts`), the chat asks the user whether to search the web instead, and only then re-runs with
  `source: "web"`: ChatGPT's web search (`lib/web/openai-search.ts`, OpenAI Responses API; offered only with
  `OPENAI_API_KEY` set; papers must match a URL the search returned). It never runs without that consent, its prompt does not use `withKg()` (the KG rules forbid other tools), and its results are
  marked as web results (no `soa:` typing, no KG statistics). Do not add further sources.
- **Every query uses the ontology in `ontology/einstein.ttl`.** SPARQL templates live in `lib/kg/queries.ts` and may
  only use classes and properties defined there (`checkQuery` refuses others). Look a term up in the ontology before
  using it (e.g. DOIs are `prism:doi`, not `datacite:doi`).
- **LLM prompts go through `withKg()` in `lib/agents/pipeline.ts`**, which adds the MCP/ontology instructions and the
  ontology summary. New agents must use it too.
- Evidence graphs (`lib/export.ts`) use Einstein's terms (`ein:`) and type SemOpenAlex resources with their `soa:` class.
- Check with `npm run typecheck`.
