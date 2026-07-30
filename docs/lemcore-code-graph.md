# Lemcore codebase graph (code-review-graph)

Lemcore is the long-lived structured agent executor. On **every** repository
scan it builds a codebase graph and uses that graph when assembling
implementation context, so the LLM receives compact structural slices instead
of bulk raw-file dumps.

Other executors (`hermes`, `internal`) are **not** wired to this integration.

## Flow

1. `runLemcoreTask` starts for a cloned workdir.
2. `scanRepositoryGraph` invokes the [code-review-graph](https://github.com/tirth8205/code-review-graph)
   CLI (`build` + `status` + `architecture`) with graph data stored **beside**
   the clone (`$workdir.lemcore-graph-data` by default) so artifacts never land
   in the task PR.
3. On CLI failure or missing binary, lemcore **fail-soft** falls back to a
   local import/file structural scan — the run continues.
4. `buildLemcoreImplContext` serializes a compact graph summary (and a task
   neighborhood when paths appear in the prompt) into the user message.
5. During the tool loop, lemcore can call `graph_query`, `graph_impact`,
   `graph_neighbors`, and `graph_search` against the scan-session graph.

## Install (local / CI worker image)

```bash
pip install 'code-review-graph==2.3.7'
# binary on PATH:
code-review-graph --version
```

The backend runtime image installs the same package (see `backend/Dockerfile`)
alongside Python 3 so workers can build graphs without a separate sidecar.

If the CLI is absent, lemcore still scans via the fallback graph and logs
`codebase graph ready (fallback)` (or `unavailable` only when even the
fallback fails).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `LEMCORE_CODE_GRAPH` | `true` | Master switch (lemcore only) |
| `LEMCORE_CODE_GRAPH_MAX_DEPTH` | `2` | Neighborhood / impact hop depth |
| `LEMCORE_CODE_GRAPH_DATA_DIR` | *(sibling of workdir)* | Override graph DB directory |
| `LEMCORE_CODE_GRAPH_CLI` | `code-review-graph` | CLI name or absolute path |
| `LEMCORE_CODE_GRAPH_TIMEOUT_MS` | `120000` | Build timeout |

## Token impact

Task events log an estimated summary-vs-raw token comparison after each scan,
for example:

```text
codebase graph ready (code-review-graph): 120 files, 400 nodes, 350 edges; ~900 summary tokens vs ~48000 raw (~98% fewer)
implementation context from graph (code-review-graph): ~950 tokens (~98% under raw dump estimate)
```

Exact savings depend on repo size; the design target is a clear double-digit
percent drop versus stuffing key-file corpora into the prompt.

## Code map

| Path | Role |
|---|---|
| `backend/src/lib/lemcore/graph/` | Adapter (CLI, parse, fallback, query, summary) |
| `backend/src/lib/lemcore/graph-scan.ts` | Per-scan hook + session store |
| `backend/src/lib/lemcore/graph-context.ts` | Implementation context assembly |
| `backend/src/lib/lemcore/graph-tools.ts` | LLM tool handlers |
| `backend/src/lib/lemcore/run.ts` | Wires scan → context → loop |
