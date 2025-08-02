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
    const npmInstallArgs = core.getInput('npm-install-args') || '--legacy-peer-deps';

    // Initialize GitHub client
    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    // Check if we're in a PR
    const isPR = context.eventName === 'pull_request';
    
    core.info(`Working directory: ${workingDirectory}`);
    core.info(`Event: ${context.eventName}`);
    core.info(`Is PR: ${isPR}`);
    core.info(`Base branch: ${baseBranch}`);

    if (!isPR) {
      core.info('Not a pull request, skipping bundle size analysis');
      return;
    }

    // Analyze current bundle (PR branch)
    const currentBundleStats = await analyzeBundleSize(workingDirectory);
    
    if (!currentBundleStats) {
      core.setFailed('Could not analyze bundle size. Make sure the Next.js project is built.');
      return;
    }

    // Get base branch bundle stats for comparison
    const baseStats = await getBaseBranchStats(workingDirectory, baseBranch, npmInstallArgs);

    // For PRs, create comment with bundle size comparison
    await handlePullRequest(octokit, context, currentBundleStats, baseStats, commentStrategy);

  } catch (error) {
    core.setFailed(error.message);
  }
}

async function analyzeBundleSize(workingDir) {
  const nextDir = path.join(workingDir, '.next');
  const appBuildManifestPath = path.join(nextDir, 'app-build-manifest.json');
  
  if (!await fs.pathExists(appBuildManifestPath)) {
    core.warning('App build manifest not found. Make sure Next.js build has completed with App Router.');
    return null;
  }

  try {
    const appBuildManifest = await fs.readJson(appBuildManifestPath);
    const stats = {};
    
    core.info(`App build manifest loaded successfully from ${appBuildManifestPath}`);
    
    if (!appBuildManifest.pages || Object.keys(appBuildManifest.pages).length === 0) {
      core.warning('No app routes found in build manifest. This might indicate an incomplete build.');
    }

    // Analyze app routes
    if (appBuildManifest.pages) {
      core.info(`Found ${Object.keys(appBuildManifest.pages).length} app routes in build manifest`);
      
      for (const [route, files] of Object.entries(appBuildManifest.pages)) {
        let totalSize = 0;
        let foundFiles = 0;
        
        core.debug(`Analyzing app route: ${route} with ${files.length} files`);
        
        for (const file of files) {
          const filePath = path.join(nextDir, file);
          if (await fs.pathExists(filePath)) {
            const stat = await fs.stat(filePath);
            totalSize += stat.size;
            foundFiles++;
            core.debug(`  Found: ${file} (${formatBytes(stat.size)})`);
          } else {
            core.debug(`  Missing: ${file} (expected at ${filePath})`);
          }
        }
        
        stats[route] = {
          size: totalSize,
          files: foundFiles
        };
        
        core.info(`  ${route}: ${formatBytes(totalSize)} (${foundFiles}/${files.length} files found)`);
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
      routes: stats,
      totalSize: totalBundleSize,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    core.error(`Error analyzing bundle: ${error.message}`);
    return null;
  }
}

async function handlePullRequest(octokit, context, currentStats, baseStats, commentStrategy) {
  const { owner, repo } = context.repo;
  const prNumber = context.payload.pull_request.number;
  
  // Generate comparison comment
  const commentBody = generateComparisonComment(currentStats, baseStats);
  
  // Skip commenting if strategy is skip-insignificant and no significant changes
  if (commentStrategy === 'skip-insignificant' && !hasSignificantChanges(currentStats, baseStats)) {
    core.info('No significant changes detected, skipping comment');
    return;
  }

  try {
    core.info(`Attempting to comment on PR #${prNumber}`);
    
    // Check if we have the necessary permissions by testing with a simple API call first
    try {
      await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      });
      core.info('Successfully accessed PR information');
    } catch (permError) {
      core.error(`Cannot access PR: ${permError.message}`);
      throw permError;
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
  } catch (error) {
    core.error(`Failed to post comment: ${error.message}`);
    
    // Log more details about the error
    if (error.status === 403) {
      core.error('Permission denied. The GITHUB_TOKEN may not have sufficient permissions.');
      core.error('Make sure the workflow has "pull-requests: write" permission.');
    }
    
    // Don't fail the action if commenting fails
    core.warning('Could not post bundle size comment, but analysis completed successfully');
  }
}



async function getBaseBranchStats(workingDir, baseBranch, npmInstallArgs = '--legacy-peer-deps') {
  const { execSync } = require('child_process');
  
  try {
    core.info(`Fetching base branch stats from ${baseBranch}`);
    
    // Save current branch/commit
    const currentRef = execSync('git rev-parse HEAD', { cwd: workingDir, encoding: 'utf8' }).trim();
    
    // Fetch and checkout base branch
    execSync(`git fetch origin ${baseBranch}`, { cwd: workingDir });
    execSync(`git checkout origin/${baseBranch}`, { cwd: workingDir });
    
    // Install dependencies and build
    core.info(`Installing dependencies for base branch with args: ${npmInstallArgs}`);
    execSync(`npm ci ${npmInstallArgs}`, { cwd: workingDir });
    
    core.info('Building base branch...');
    execSync('npm run build', { cwd: workingDir });
    
    // Analyze base branch bundle
    const baseStats = await analyzeBundleSize(workingDir);
    
    // Restore original commit
    execSync(`git checkout ${currentRef}`, { cwd: workingDir });
    
    return baseStats;
  } catch (error) {
    core.warning(`Could not analyze base branch: ${error.message}`);
    
    // Try to restore original commit on error
    try {
      const currentRef = execSync('git rev-parse HEAD', { cwd: workingDir, encoding: 'utf8' }).trim();
      execSync(`git checkout ${currentRef}`, { cwd: workingDir });
    } catch (restoreError) {
      core.warning(`Could not restore original commit: ${restoreError.message}`);
    }
    
    return null;
  }
}

function generateComparisonComment(currentStats, baseStats) {
  let comment = '<!-- BUNDLE-SIZE-BOT -->\n\n';
  comment += '## 📦 Bundle Size Analysis\n\n';

  if (!baseStats) {
    comment += '> **Note**: Could not analyze base branch for comparison. Showing current bundle sizes only.\n\n';
    comment += generateCurrentStatsTable(currentStats);
  } else {
    comment += generateComparisonTable(currentStats, baseStats);
  }

  comment += '\n---\n*Bundle size analysis powered by Next.js Bundle Size Action*';
  
  return comment;
}

function generateCurrentStatsTable(stats) {
  let table = '### Current Bundle Sizes\n\n';
  table += '| Route | Size | Files |\n';
  table += '|-------|------|-------|\n';

  for (const [route, data] of Object.entries(stats.routes)) {
    const sizeFormatted = formatBytes(data.size);
    table += `| ${route} | ${sizeFormatted} | ${data.files} |\n`;
  }

  table += `\n**Total Bundle Size**: ${formatBytes(stats.totalSize)}\n`;
  
  return table;
}



function generateComparisonTable(currentStats, baseStats) {
  let table = '### Bundle Size Comparison\n\n';
  table += '| Route | Current | Base | Diff | Change |\n';
  table += '|-------|---------|------|------|--------|\n';

  const allRoutes = new Set([
    ...Object.keys(currentStats.routes),
    ...Object.keys(baseStats.routes)
  ]);

  for (const route of allRoutes) {
    const current = currentStats.routes[route] || { size: 0, files: 0 };
    const base = baseStats.routes[route] || { size: 0, files: 0 };
    
    const diff = current.size - base.size;
    const diffFormatted = diff > 0 ? `+${formatBytes(diff)}` : formatBytes(diff);
    const changeIcon = diff > 0 ? '🔺' : diff < 0 ? '🔻' : '➖';
    
    table += `| ${route} | ${formatBytes(current.size)} | ${formatBytes(base.size)} | ${diffFormatted} | ${changeIcon} |\n`;
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
