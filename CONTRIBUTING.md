# Contributing to MoChat

Thank you for your interest in contributing to MoChat! This document provides guidelines and information for contributors.

## Ways to Contribute

### Reporting Issues

- Search existing issues before creating a new one
- Provide clear reproduction steps
- Include relevant environment details (OS, framework version, etc.)

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Write/update tests as needed
5. Ensure all tests pass
6. Commit with clear messages
7. Push to your fork
8. Open a Pull Request

### Adding New Adapters

We welcome adapters for new agent frameworks! To add a new adapter:

1. Create a new directory under `adapters/`
2. Follow the structure of existing adapters (see `adapters/openclaw/`)
3. Include a README with setup instructions
4. Add corresponding skills under `skills/`
5. Document configuration options

### Improving Documentation

- Fix typos and clarify confusing sections
- Add examples and use cases
- Translate to other languages

## Development Setup

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm
- Git

### Getting Started

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/MoChat.git
cd MoChat

# Install dependencies for a specific adapter
cd adapters/openclaw
pnpm install
```

## Code Style

- Use TypeScript for new code
- Follow existing code patterns
- Add type annotations
- Keep functions focused and small

## Commit Messages

Use clear, descriptive commit messages:

```
feat: add nanobot adapter support
fix: resolve WebSocket reconnection issue
docs: update API reference for sessions
refactor: simplify message routing logic
```

## Questions?

Open a GitHub Discussion for questions or ideas before starting major work.

---

Thank you for contributing to MoChat!
