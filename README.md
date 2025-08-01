# Next.js Bundle Size Action

A GitHub Action that analyzes Next.js bundle sizes and comments the comparison on pull requests, similar to the TransferWise bundle analyzer.

## Features

- 📊 Analyzes Next.js bundle sizes from build output
- 💬 Comments bundle size comparisons on pull requests
- 📈 Shows size differences compared to base branch
- 🎯 Configurable comment strategies
- 🔄 Updates existing comments instead of creating new ones

## Usage

Add this action to your workflow after building your Next.js project:

```yaml
name: Bundle Size Analysis

on:
  pull_request:
  push:
    branches: [main]

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build Next.js app
        run: npm run build
      
      - name: Analyze bundle sizes
        uses: ./
        with:
          working-directory: '.'
          github-token: ${{ secrets.GITHUB_TOKEN }}
          comment-strategy: 'always'
          base-branch: 'main'
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `working-directory` | Directory containing the Next.js project | No | `.` |
| `github-token` | GitHub token for commenting on PRs | No | `${{ github.token }}` |
| `comment-strategy` | When to comment: `always` or `skip-insignificant` | No | `always` |
| `base-branch` | Base branch to compare against | No | `main` |

## Comment Strategy

- **`always`**: Always comment on PRs, even if there are no significant changes
- **`skip-insignificant`**: Skip commenting if bundle size changes are less than 1KB

## Example Comment

The action will create comments like this on your PRs:

```markdown
## 📦 Bundle Size Analysis

### Bundle Size Comparison

| Page | Current | Base | Diff | Change |
|------|---------|------|------|--------|
| / | 245.2 KB | 243.1 KB | +2.1 KB | 🔺 |
| /about | 156.8 KB | 156.8 KB | 0 B | ➖ |
| /contact | 167.3 KB | 169.1 KB | -1.8 KB | 🔻 |

**Total**: 569.3 KB (+0.3 KB 🔺)
```

## Development

To build and package the action:

```bash
npm install
npm run build
```

## How It Works

1. **Build Analysis**: Reads the Next.js build manifest to analyze bundle sizes
2. **Base Comparison**: Compares current bundle with base branch data (stored in GitHub issues)
3. **PR Comments**: Creates or updates comments with size comparisons
4. **Smart Updates**: Finds and updates existing comments instead of creating duplicates

## License

MIT
