# Code style

- No artificial optionality. Make required fields required. Do not add fallbacks when the caller should supply a value.
- No speculative complexity. Anticipate later needs in the design, but do not build unconfirmed fields or capabilities.
- Validate at package and I/O boundaries. Trust the type-checker for internal contracts.
- Avoid pass-through functions that add no distinct value.

# Project boundaries

- `@torkbot/code-mode` owns runtime-agnostic code-mode contracts.
- `@torkbot/sandbox` owns isolated VM execution.
- This package owns their integration. Do not move substrate-specific behavior into `@torkbot/code-mode`.

