# Hosted Symphony

Hosted Symphony is a private VS Code extension for configuring and monitoring a hosted Symphony deployment.

## Features

- Save a shared service token in VS Code secret storage
- Connect a GitHub repo and Linear project to the hosted control plane
- Scaffold a hosted-compatible `WORKFLOW.md`
- Validate hosted workflow config
- Monitor running and retrying issues through the activity bar tree and issue detail views

## Private install

Package the extension:

```bash
npm run package:extension
```

Install the generated VSIX:

```bash
code --install-extension apps/vscode-extension/hosted-symphony.vsix
```

## Configuration

- `hostedSymphony.baseUrl`: control plane base URL from the Azure deployment output
- `hostedSymphony.environment`: staging or prod

## Hosted setup

1. Deploy the Azure stack in [`infra/azure`](/Users/clawd/Documents/RockBand/infra/azure/README.md).
2. Set `hostedSymphony.baseUrl` to the deployed control-plane URL.
3. Run `Hosted Symphony: Sign In` and paste the shared service token.
4. Run `Hosted Symphony: Connect Repo`, then validate `WORKFLOW.md`.
