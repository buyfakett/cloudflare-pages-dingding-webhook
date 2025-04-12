import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch, { Response } from 'node-fetch';

import { context } from '@actions/github/lib/utils';
import { ApiResponse, AuthHeaders, Deployment } from './types';

let waiting = true;
// @ts-ignore - Typing GitHub's responses is a pain in the ass
let ghDeployment;
let markedAsInProgress = false;

export default async function run() {
  const accountEmail = core.getInput('accountEmail', { required: false, trimWhitespace: true });
  const apiKey = core.getInput('apiKey', { required: false, trimWhitespace: true });
  const apiToken = core.getInput('apiToken', { required: false, trimWhitespace: true })

  const accountId = core.getInput('accountId', { required: true, trimWhitespace: true });
  const project = core.getInput('project', { required: true, trimWhitespace: true });
  const token = core.getInput('githubToken', { required: false, trimWhitespace: true });
  const commitHash = core.getInput('commitHash', { required: false, trimWhitespace: true });
  // 获取git commit信息
  const commitMessage = require('child_process').execSync('git log -1 --pretty=format:"%s"').toString().trim();
  const commitAuthor = require('child_process').execSync('git log -1 --pretty=format:"%an"').toString().trim();
  const commitDate = require('child_process').execSync('git log -1 --pretty=format:"%cd" --date=format:"%Y-%m-%d %H:%M UTC+8" --date=+8hours').toString().trim();
  
  const dingWebHookKey = core.getInput('dingWebHookKey', { required: false, trimWhitespace: true });
  const dingWebHook = dingWebHookKey ? `https://oapi.dingtalk.com/robot/send?access_token=${dingWebHookKey}` : '';
  const commitUrl = context.payload?.head_commit?.url || '';
  const actor = context?.actor || '';

  // Validate we have either token or both email + key
  if (!validateAuthInputs(apiToken, accountEmail, apiKey)) {
    return;
  }

  const authHeaders: AuthHeaders = apiToken !== '' ? { Authorization: `Bearer ${apiToken}` } : { 'X-Auth-Email': accountEmail, 'X-Auth-Key': apiKey };

  console.log('等待CloudFlare Pages完成构建...');
  let lastStage = '';

  while (waiting) {
    // We want to wait a few seconds, don't want to spam the API :)
    await sleep();

    const deployment: Deployment|undefined = await pollApi(authHeaders, accountId, project, commitHash);
    if (!deployment) {
      console.log('正在等待部署开始...');
      continue;
    }

    if ((deployment as any).is_skipped === true) {
      waiting = false;
      console.log(`Deployment skipped ${deployment.id}!`);
      core.setOutput('status', `Deployment skipped ${deployment.id}!`);
      return;
    }

    const latestStage = deployment.latest_stage;

    if (latestStage.name !== lastStage) {
      lastStage = deployment.latest_stage.name;
      console.log('# 现阶段是: ' + lastStage);

      if (!markedAsInProgress) {
        await updateDeployment(token, deployment, 'in_progress');
        markedAsInProgress = true;
      }
    }

    if (latestStage.status === 'failed') {
      waiting = false;

      if (dingWebHook) {
        const logs = await getCloudflareLogs(authHeaders, accountId, project, deployment.id);
        fetch(dingWebHook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'text',
            text: { content: `❌ CloudFlare Pages ${latestStage.name} 流水线项目 ${project} 失败！
环境： ${deployment.environment}
提交： ${commitUrl}
提交信息：${commitMessage}
提交者：${commitAuthor} (${commitDate})
部署 ID： ${deployment.id}
查看构建日志: https://dash.cloudflare.com?to=/${accountId}/pages/view/${deployment.project_name}/${deployment.id}
部署日志：${logs}`
            }
          })
        }).then(response => {
          if (!response.ok) {
            console.error('钉消息发送失败！', response.statusText);
          } else {
            console.log('钉消息发送成功！', response.statusText);
          }
        }).catch(err => {
          console.error('发送钉钉消息时出错：', err);
        });
      }
      core.setFailed(`步骤部署失败: ${latestStage.name}!`);
      await updateDeployment(token, deployment, 'failure');
      return;
    }
    async function getCloudflareLogs(authHeaders: AuthHeaders, accountId: string, project: string, deploymentId: string): Promise<string> {
      try {
        const res: Response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments/${deploymentId}/history/logs`, {
          headers: { ...authHeaders },
        });
    
        if (!res.ok) {
          console.error(`无法获取Cloudflare日志-状态代码: ${res.status} (${res.statusText})`);
          return '';
        }
    
        const body = await res.json() as any;
    
        if (Array.isArray(body.result?.data) && body.result.data.length > 0) {
          const logs = (body.result.data as Array<any>).map((log) => {
            return {
              line: log.line,
            };
          });
    
          const last20Logs = logs.slice(-20);
    
          const formattedLogs = last20Logs.map((log) => {
            return `${log.line}`;
          });
    
          return '```' + formattedLogs.join('\n') + '\n```';
        } else {
          return '';
        }
      } catch (error: any) {
        console.error(`无法获取Cloudflare日志: ${error.message}`);
        return '';
      }
    }
        
    if (latestStage.name === 'deploy' && ['success', 'failed'].includes(latestStage.status)) {
      waiting = false;

      const aliasUrl = deployment.aliases && deployment.aliases.length > 0 ? deployment.aliases[0] : deployment.url;

      // Set outputs
      core.setOutput('id', deployment.id);
      core.setOutput('environment', deployment.environment);
      core.setOutput('url', deployment.url);
      core.setOutput('alias', aliasUrl);
      core.setOutput('success', deployment.latest_stage.status === 'success' ? true : false);

      if (deployment.latest_stage.status === 'success' && true) {
        fetch(dingWebHook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'text',
            text: { content: `✅ CloudFlare Pages 项目的部署流水线项目 ${project} 成功！
环境：${deployment.environment}
提交：${commitUrl}
提交信息：${commitMessage}
提交者：${commitAuthor} (${commitDate}) 
部署 ID： ${deployment.id}
别名 URL： ${aliasUrl}
部署 URL： ${deployment.url}
查看构建日志: https://dash.cloudflare.com?to=/${accountId}/pages/view/${deployment.project_name}/${deployment.id}`
            }
          })
        }).then(response => {
          if (!response.ok) {
            console.error('钉消息发送失败！', response.statusText);
          } else {
            console.log('钉消息发送成功！', response.statusText);
          }
        }).catch(err => {
          console.error('发送钉钉消息时出错：', err);
        });        
      }
      // Update deployment (if enabled)
      if (token !== '') {
        await updateDeployment(token, deployment, latestStage.status === 'success' ? 'success' : 'failure');
      }
    }
  }
}

function validateAuthInputs(token: string, email: string, key: string) {
  if (token !==  '') {
    return true;
  }

  if (email !== '' && key !== '') {
    return true;
  }

  core.setFailed('请指定身份验证详细信息！设置“apiToken”或“accountEmail”+“accountKey”！');
  return false;
}

async function pollApi(authHeaders: AuthHeaders, accountId: string, project: string, commitHash: string): Promise<Deployment|undefined> {
  // curl -X GET "https://api.cloudflare.com/client/v4/accounts/:account_id/pages/projects/:project_name/deployments" \
  //   -H "X-Auth-Email: user@example.com" \
  //   -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41"
  let res: Response;
  let body: ApiResponse;
  // Try and fetch, may fail due to a network issue
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments?sort_by=created_on&sort_order=desc`, {
      headers: { ...authHeaders },
    });
  } catch(e) {
    // @ts-ignore
    core.error(`向CF API发送请求失败-网络问题？ ${e.message}`);
    // @ts-ignore
    core.setFailed(e);
    return;
  }

  // If the body isn't a JSON then fail - CF seems to do this sometimes?
  try {
    body = await res.json() as ApiResponse;
  } catch(e) {
    core.error(`CF API未返回JSON（可能关闭？）-状态代码: ${res.status} (${res.statusText})`);
    // @ts-ignore
    core.setFailed(e);
    return;
  }

  if (!body.success) {
    waiting = false;
    const error = body.errors.length > 0 ? body.errors[0] : '位置错误!';
    core.setFailed(`检查部署状态失败！错误: ${JSON.stringify(error)}`);
    return;
  }

  if (!commitHash) return body.result?.[0];
  return body.result?.find?.(deployment => deployment.deployment_trigger?.metadata?.commit_hash === commitHash);
}

async function sleep() {
  return new Promise((resolve) => setTimeout(resolve, 5000));
}

// Credits to Greg for this code <3
async function updateDeployment(token: string, deployment: Deployment, state: 'success'|'failure'|'in_progress') {
  if (!token) return;

  const octokit = github.getOctokit(token);

  const environment = deployment.environment === 'production'
    ? 'Production'
    : `Preview (${deployment.deployment_trigger.metadata.branch})`;

  const sharedOptions = {
    owner: context.repo.owner,
    repo: context.repo.repo,
  };

  // @ts-ignore
  if (!ghDeployment) {
    const { data } = await octokit.rest.repos.createDeployment({
      ...sharedOptions,
      ref: deployment.deployment_trigger.metadata.commit_hash,
      auto_merge: false,
      environment,
      production_environment: deployment.environment === 'production',
      description: 'Cloudflare Pages',
      required_contexts: [],
    });
    ghDeployment = data;
  }

  if (deployment.latest_stage.name === 'deploy' && ['success', 'failed'].includes(deployment.latest_stage.status)) {
    // @ts-ignore - Env is not typed correctly
    await octokit.rest.repos.createDeploymentStatus({
      ...sharedOptions,
      // @ts-ignore - Typing createDeployment is a pain
      deployment_id: ghDeployment.id,
      // @ts-ignore - Env is not typed correctly
      environment,
      environment_url: deployment.url,
      log_url: `https://dash.cloudflare.com?to=/:account/pages/view/${deployment.project_name}/${deployment.id}`,
      description: 'Cloudflare Pages',
      state,
    });
  }
}

try {
  run();
} catch(e) {
  console.error('请报告问题: https://github.com/WalshyDev/cf-pages-await/issues');
  // @ts-ignore
  core.setFailed(e);
  // @ts-ignore
  console.error(e.message + '\n' + e.stack);
}
