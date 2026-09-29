.PHONY: check check-identifiers check-secrets check-plugins hooks

# Deterministic local checks (same as the pre-push hook, plus a working-tree scan).
check: check-identifiers check-secrets

check-identifiers:
	scripts/check-identifiers.sh --all

check-secrets:
	gitleaks git --no-banner --redact
	gitleaks dir --no-banner --redact .

# Typecheck, lint and build every plugin (one at a time, memory bounded).
check-plugins:
	@for p in plugins/*/; do \
	  echo "== $$p"; \
	  (cd $$p && npm ci && npm run tsc && npm run lint && npm run build) || exit 1; \
	done

hooks:
	pre-commit install
