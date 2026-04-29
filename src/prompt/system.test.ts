import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Config } from '../config.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { buildAgentSystemPrompt, loadAgentProfile } from './system.js';

function buildTestConfig(): Config {
    const config = structuredClone(DEFAULT_CONFIG) as Config;
    config.exec.allowedCommands = ['ls'];
    config.exec.deniedCommands = ['rm'];
    return config;
}

test('loadAgentProfile reads active profile markdown from configured directory', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'srebot-profile-'));
    const profileDir = join(tempDir, 'profiles');

    try {
        await mkdir(profileDir, { recursive: true });
        await writeFile(join(profileDir, 'support.md'), '# Support\n\nUse llm-wiki first.', 'utf-8');

        const config = buildTestConfig();
        config.agent.profile_dir = profileDir;
        config.agent.active_profile = 'support';

        const profile = await loadAgentProfile({ config, workspacePath: tempDir });
        assert.equal(profile.id, 'support');
        assert.equal(profile.builtIn, false);
        assert.match(profile.content, /Use llm-wiki first/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('buildAgentSystemPrompt injects profile content without hardcoded SRE identity', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'srebot-profile-prompt-'));
    const profileDir = join(tempDir, 'agent-profiles');

    try {
        await mkdir(profileDir, { recursive: true });
        await writeFile(
            join(profileDir, 'support.md'),
            '# Support Profile\n\n你是 Support Agent。\n\n优先使用 llm-wiki 相关 skill。',
            'utf-8',
        );

        const config = buildTestConfig();
        config.agent.profile_dir = profileDir;
        config.agent.active_profile = 'support';
        const profile = await loadAgentProfile({ config, workspacePath: tempDir });

        const prompt = buildAgentSystemPrompt({
            config,
            workspacePath: tempDir,
            profile,
            toolSummaryLines: ['- memory_search: search memory'],
            channelWorkspaceRules: ['- write files to workspace/tmp'],
            memoryContext: '记忆采用按需检索模式。',
        });

        assert.match(prompt, /active_profile: support/);
        assert.match(prompt, /Support Wiki Root:/);
        assert.match(prompt, /Support Query Budget/);
        assert.match(prompt, /support_query_runner\.py/);
        assert.match(prompt, /SUPPORT_QUERY_NO_HIT/);
        assert.match(prompt, /你是 Support Agent/);
        assert.match(prompt, /优先使用 llm-wiki/);
        assert.doesNotMatch(prompt, /你是 SREBot/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('loadAgentProfile falls back to built-in SRE profile only for default sre id', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'srebot-profile-builtin-'));

    try {
        const config = buildTestConfig();
        config.agent.profile_dir = join(tempDir, 'missing-profiles');
        config.agent.active_profile = 'sre';

        const profile = await loadAgentProfile({ config, workspacePath: tempDir });
        assert.equal(profile.id, 'sre');
        assert.equal(profile.builtIn, true);
        assert.match(profile.content, /你是 SREBot/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
