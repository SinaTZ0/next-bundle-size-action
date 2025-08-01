const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs-extra');
const path = require('path');

async function run() {
  try {
    // Get inputs
    const workingDirectory = core.getInput('working-directory') || '.';
    const githubToken = core.getInput('github-token');
    const commentStrategy = core.getInput('comment-strategy') || 'always';
    const baseBranch = core.getInput('base-branch') || 'main';

    // Initialize GitHub client
    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    // Check if we're in a PR
    const isPR = context.eventName === 'pull_request';
    
    core.info(`Working directory: ${workingDirectory}`);
    core.info(`Event: ${context.eventName}`);
    core.info(`Is PR: ${isPR}`);

    // Analyze current bundle
    const currentBundleStats = await analyzeBundleSize(workingDirectory);
    
    if (!currentBundleStats) {
      core.setFailed('Could not analyze bundle size. Make sure the Next.js project is built.');
      return;
    }

    if (isPR) {
      // For PRs, compare with base branch and comment
      await handlePullRequest(octokit, context, currentBundleStats, commentStrategy, baseBranch);
    } else {
      // For main branch, store the bundle stats for future comparisons
      await storeBundleStats(currentBundleStats, context);
    }

  } catch (error) {
    core.setFailed(error.message);
  }
}

async function analyzeBundleSize(workingDir) {
  const nextDir = path.join(workingDir, '.next');
  const buildManifestPath = path.join(nextDir, 'build-manifest.json');
  
  if (!await fs.pathExists(buildManifestPath)) {
    core.warning('Build manifest not found. Make sure Next.js build has completed.');
    return null;
  }

  try {
    const buildManifest = await fs.readJson(buildManifestPath);
    const stats = {};

    // Analyze pages
    if (buildManifest.pages) {
      for (const [page, files] of Object.entries(buildManifest.pages)) {
        let totalSize = 0;
        
        for (const file of files) {
          const filePath = path.join(nextDir, 'static', file);
          if (await fs.pathExists(filePath)) {
            const stat = await fs.stat(filePath);
            totalSize += stat.size;
          }
        }
        
        stats[page] = {
          size: totalSize,
          files: files.length
        };
      }
    }

    // Get total bundle size
    const staticDir = path.join(nextDir, 'static');
    let totalBundleSize = 0;
    
    if (await fs.pathExists(staticDir)) {
      const calculateDirSize = async (dir) => {
        let size = 0;
        const items = await fs.readdir(dir);
        
        for (const item of items) {
          const itemPath = path.join(dir, item);
          const stat = await fs.stat(itemPath);
          
          if (stat.isDirectory()) {
            size += await calculateDirSize(itemPath);
          } else {
            size += stat.size;
          }
        }
        
        return size;
      };
      
      totalBundleSize = await calculateDirSize(staticDir);
    }

    return {
      pages: stats,
      totalSize: totalBundleSize,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    core.error(`Error analyzing bundle: ${error.message}`);
    return null;
  }
}

async function handlePullRequest(octokit, context, currentStats, commentStrategy, baseBranch) {
  const { owner, repo } = context.repo;
  const prNumber = context.payload.pull_request.number;

  // Try to get base branch stats from artifacts or issues
  const baseStats = await getBaseBranchStats(octokit, owner, repo, baseBranch);
  
  // Generate comparison comment
  const commentBody = generateComparisonComment(currentStats, baseStats);
  
  // Skip commenting if strategy is skip-insignificant and no significant changes
  if (commentStrategy === 'skip-insignificant' && !hasSignificantChanges(currentStats, baseStats)) {
    core.info('No significant changes detected, skipping comment');
    return;
  }

  // Find existing comment
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber
  });

  const botComment = comments.data.find(comment => 
    comment.body.includes('<!-- BUNDLE-SIZE-BOT -->')
  );

  if (botComment) {
    // Update existing comment
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: botComment.id,
      body: commentBody
    });
    core.info('Updated existing bundle size comment');
  } else {
    // Create new comment
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody
    });
    core.info('Created new bundle size comment');
  }
}

async function getBaseBranchStats(octokit, owner, repo, baseBranch) {
  try {
    // Try to find bundle stats issue
    const issues = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      labels: 'bundle-stats',
      state: 'open'
    });

    const statsIssue = issues.data.find(issue => 
      issue.title.includes('Bundle Size Stats')
    );

    if (statsIssue && statsIssue.body) {
      // Extract stats from issue body
      const statsMatch = statsIssue.body.match(/```json\n([\s\S]*?)\n```/);
      if (statsMatch) {
        return JSON.parse(statsMatch[1]);
      }
    }
  } catch (error) {
    core.warning(`Could not retrieve base branch stats: ${error.message}`);
  }
  
  return null;
}

async function storeBundleStats(stats, context) {
  // This would typically store stats in an issue or artifact for future comparisons
  core.info('Storing bundle stats for future comparisons');
  
  const statsJson = JSON.stringify(stats, null, 2);
  core.info(`Bundle stats: ${statsJson}`);
  
  // You could extend this to create/update a GitHub issue with the stats
}

function generateComparisonComment(currentStats, baseStats) {
  let comment = '<!-- BUNDLE-SIZE-BOT -->\n\n';
  comment += '## 📦 Bundle Size Analysis\n\n';

  if (!baseStats) {
    comment += '> **Note**: No base branch data available for comparison. This is likely the first run on the base branch.\n\n';
    comment += generateCurrentStatsTable(currentStats);
  } else {
    comment += generateComparisonTable(currentStats, baseStats);
  }

  comment += '\n---\n*Bundle size analysis powered by Next.js Bundle Size Action*';
  
  return comment;
}

function generateCurrentStatsTable(stats) {
  let table = '### Current Bundle Sizes\n\n';
  table += '| Page | Size | Files |\n';
  table += '|------|------|-------|\n';

  for (const [page, data] of Object.entries(stats.pages)) {
    const sizeFormatted = formatBytes(data.size);
    table += `| ${page} | ${sizeFormatted} | ${data.files} |\n`;
  }

  table += `\n**Total Bundle Size**: ${formatBytes(stats.totalSize)}\n`;
  
  return table;
}

function generateComparisonTable(currentStats, baseStats) {
  let table = '### Bundle Size Comparison\n\n';
  table += '| Page | Current | Base | Diff | Change |\n';
  table += '|------|---------|------|------|--------|\n';

  const allPages = new Set([
    ...Object.keys(currentStats.pages),
    ...Object.keys(baseStats.pages)
  ]);

  for (const page of allPages) {
    const current = currentStats.pages[page] || { size: 0, files: 0 };
    const base = baseStats.pages[page] || { size: 0, files: 0 };
    
    const diff = current.size - base.size;
    const diffFormatted = diff > 0 ? `+${formatBytes(diff)}` : formatBytes(diff);
    const changeIcon = diff > 0 ? '🔺' : diff < 0 ? '🔻' : '➖';
    
    table += `| ${page} | ${formatBytes(current.size)} | ${formatBytes(base.size)} | ${diffFormatted} | ${changeIcon} |\n`;
  }

  const totalDiff = currentStats.totalSize - baseStats.totalSize;
  const totalDiffFormatted = totalDiff > 0 ? `+${formatBytes(totalDiff)}` : formatBytes(totalDiff);
  const totalChangeIcon = totalDiff > 0 ? '🔺' : totalDiff < 0 ? '🔻' : '➖';

  table += `\n**Total**: ${formatBytes(currentStats.totalSize)} (${totalDiffFormatted} ${totalChangeIcon})\n`;
  
  return table;
}

function hasSignificantChanges(currentStats, baseStats, threshold = 1024) {
  if (!baseStats) return true;
  
  const totalDiff = Math.abs(currentStats.totalSize - baseStats.totalSize);
  return totalDiff > threshold;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

run();
