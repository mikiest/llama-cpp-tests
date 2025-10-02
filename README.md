# llama-testgen

Generate focused unit tests for React/React Native TypeScript projects using local or remote models via **node-llama-cpp**.

## Install
```bash
pnpm i
pnpm build
```

> You need a local or remote model compatible with node-llama-cpp (GGUF files are common, but not required). Example: code-specialized 7B–14B models (Q6_K/Q8_0 recommended).

## Usage
```bash
llama-testgen <modelPathOrUrl> <projectPath> [options]
```

**Examples**
```bash
# Local model
llama-testgen ./models/qwen2.5-coder-7b.Q8_0.gguf ~/work/my-react-app

# Hugging Face shortcut (auto-download/cache via resolveModelFile)
llama-testgen hf:mradermacher/Qwen3-Coder-30B-A3B-Instruct-480B-Distill-V2-Fp32-GGUF:Q3_K_M ./my-rn-app --agent
```

**Options**
- `-o, --out <dir>`: Output dir (default: autodetect `__tests__` or `__generated-tests__`)
- `--max-files <n>`: Limit number of files
- `--min-lines <n>`: Skip very small files (default 10)
- `--include <globs...>` / `--exclude <globs...>`: Glob filters
- `--force`: Overwrite existing tests
- `--dry-run`: Only print plan
- `-v, --verbose`: Verbose logs (`--debug` remains as an alias)
- `--context <n>`: Request model context size (tokens)
- `--fast`: Future preset for faster runs
- `--agent`: **Tool-calling two-pass** (plan → tests)
- `--max-tool-calls <n>`: Cap agent tool invocations per chunk (default 40)
- Output directory is cleared on each run (skipped for `--dry-run`).

## How it works
1. **Model probe** determines usable context; planner budgets inputs, leaves headroom.
2. **Project scan** reads candidates, ignoring tests/stories/build outputs.
3. **AST chunking** splits large files by components/functions/hooks; keeps chunks under budget.
4. **Prompting** picks Jest/Vitest + Testing Library (web/native) based on deps.
5. **Generation** writes tests into the output dir, formatted with Prettier.
6. **Skips** types-only or trivial files.

## Agent mode
- Tools: `project_info`, `read_file`, `list_exports`, `find_usages`, `get_ast_digest`, `grep_text`, `infer_props_from_usage`.
- Live UX: separate spinner line shows dynamic activity like “📜  Listing exports…”, while counters remain compact.
- Two-pass: JSON **plan** first, then **tests**.
