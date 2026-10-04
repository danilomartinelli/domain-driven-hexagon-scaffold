# Convenience aliases. Package scripts and Nx targets own orchestration.
.DEFAULT_GOAL := help
.PHONY: help dev test check down

help:
	@echo 'make dev    Prepare development infrastructure, migrate and start both apps'
	@echo 'make test   Run the system E2E suite in isolated test infrastructure'
	@echo 'make check  Run the full local quality gate'
	@echo 'make down   Stop development infrastructure; keep its volumes'

dev:
	bun run dev

test:
	bun run test:e2e

check:
	bun run check:full

down:
	bun run dev:down
