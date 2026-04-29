import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { isPathInsideDir } from './file-utils.js';

const SKILL_MARKDOWN_FILE = 'SKILL.md';
const DEFAULT_SKILL_REL_PATH = SKILL_MARKDOWN_FILE;
const DEFAULT_MEMORY_REL_PATH = 'memory/scopes/main/MEMORY.md';
const SKILL_DIR_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MEMORY_REL_PATH_RE = /^memory\/scopes\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md$/u;
const MAX_SKILL_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_TREE_ENTRIES = 3000;
const MAX_WORKSPACE_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_TREE_ENTRIES = 5000;
const WORKSPACE_TEXT_FILE_RE = /\.(md|markdown|txt|json|ya?ml)$/iu;
const WORKSPACE_MARKDOWN_FILE_RE = /\.(md|markdown)$/iu;
const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
const TAG_RE = /(^|\s)#([A-Za-z0-9_\-/]+)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FRONTMATTER_RELATION_KEYS = new Set([
    'source',
    'sources',
    'source_path',
    'source_paths',
    'related',
    'relations',
    'related_to',
    'parent',
    'parents',
    'up',
    'child',
    'children',
    'down',
    'ref',
    'refs',
    'references',
    'link',
    'links',
    'see_also',
    'see-also',
    'seealso',
    'next',
    'prev',
    'previous',
    'in',
    'out',
]);
const SKIPPED_TREE_ENTRY_NAMES = new Set([
    'node_modules',
    'Thumbs.db',
    'desktop.ini',
]);

export interface WebManagedFileMeta {
    exists: boolean;
    absPath: string;
    sizeBytes?: number;
    updatedAtMs?: number;
}

export interface WebSkillFileSummary extends WebManagedFileMeta {
    skillDir: string;
}

export interface WebManagedFileReadResult extends WebManagedFileMeta {
    content?: string;
}

export interface WebSkillFileTreeNode {
    path: string;
    name: string;
    kind: 'file' | 'directory';
    sizeBytes?: number;
    updatedAtMs?: number;
    children?: WebSkillFileTreeNode[];
}

export interface WebSkillFileTreeResult {
    exists: boolean;
    skillDir: string;
    skillRootPath: string;
    tree: WebSkillFileTreeNode[];
    fileCount: number;
    directoryCount: number;
}

export type WebWorkspaceFileTreeNode = WebSkillFileTreeNode;

export interface WebWorkspaceFileTreeResult {
    exists: boolean;
    rootPath: string;
    tree: WebWorkspaceFileTreeNode[];
    fileCount: number;
    directoryCount: number;
}

export interface WebSupportWikiGraphHeading {
    level: number;
    text: string;
    slug: string;
    line: number;
}

export type WebSupportWikiGraphNodeKind = 'note' | 'unresolved';

export interface WebSupportWikiGraphNode {
    id: string;
    label: string;
    kind: WebSupportWikiGraphNodeKind;
    degree: number;
    path?: string;
    dir?: string;
    tags?: string[];
    headings?: WebSupportWikiGraphHeading[];
    sizeBytes?: number;
    updatedAtMs?: number;
}

export interface WebSupportWikiGraphEdge {
    source: string;
    target: string;
    type: 'wikilink' | 'frontmatter';
    targetRaw: string;
    alias?: string;
    resolved: boolean;
}

export interface WebSupportWikiGraphResult {
    exists: boolean;
    rootPath: string;
    summary: {
        nodeCount: number;
        edgeCount: number;
        noteCount: number;
        unresolvedCount: number;
        indexedAt: number;
    };
    nodes: WebSupportWikiGraphNode[];
    edges: WebSupportWikiGraphEdge[];
}

interface WorkspaceMarkdownRecord {
    path: string;
    name: string;
    basename: string;
    dir: string;
    absPath: string;
    sizeBytes: number;
    updatedAtMs: number;
    content: string;
}

interface ExtractedWikiLink {
    target: string;
    alias?: string;
    isEmbed: boolean;
    type: 'wikilink' | 'frontmatter';
}

function isNotFoundError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

async function resolveRootPath(rootPath: string): Promise<string> {
    const resolved = path.resolve(rootPath);
    try {
        return await fsPromises.realpath(resolved);
    } catch (error) {
        if (isNotFoundError(error)) {
            return resolved;
        }
        throw error;
    }
}

function normalizeSafeRelativePath(rawPath: string): string {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) {
        throw new Error('路径不能为空');
    }
    if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
        throw new Error('路径非法：不允许使用 . 或 ..');
    }
    return normalized;
}

function normalizeSkillDirName(skillDir: string): string {
    const normalized = skillDir.trim();
    if (!normalized) {
        throw new Error('skill 不能为空');
    }
    if (!SKILL_DIR_NAME_RE.test(normalized)) {
        throw new Error('skill 非法：仅允许字母、数字、点、下划线、中划线');
    }
    return normalized;
}

function normalizeSkillFileRelPath(rawPath?: string): string {
    const candidate = rawPath?.trim() || DEFAULT_SKILL_REL_PATH;
    return normalizeSafeRelativePath(candidate);
}

function normalizeMemoryRelPath(rawPath?: string): string {
    const candidate = rawPath?.trim() || DEFAULT_MEMORY_REL_PATH;
    const normalized = normalizeSafeRelativePath(candidate);
    if (!MEMORY_REL_PATH_RE.test(normalized)) {
        throw new Error('memory 路径非法：仅允许 memory/scopes/**/*.md');
    }
    return normalized;
}

function normalizeWorkspaceTextRelPath(rawPath?: string): string {
    const candidate = rawPath?.trim();
    if (!candidate) {
        throw new Error('path 不能为空');
    }
    const normalized = normalizeSafeRelativePath(candidate);
    if (!WORKSPACE_TEXT_FILE_RE.test(normalized)) {
        throw new Error('文件路径非法：仅支持 .md/.markdown/.txt/.json/.yaml/.yml 文本文件');
    }
    return normalized;
}

function shouldSkipTreeEntry(name: string): boolean {
    return name.startsWith('.') || SKIPPED_TREE_ENTRY_NAMES.has(name);
}

function normalizeContentPath(rawPath: string): string {
    return rawPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function stripExtension(name: string): string {
    const ext = path.posix.extname(name);
    return ext ? name.slice(0, -ext.length) : name;
}

function getPosixDirname(filePath: string): string {
    const dir = path.posix.dirname(filePath);
    return dir === '.' ? '' : dir;
}

function getPosixBasename(filePath: string): string {
    return path.posix.basename(filePath);
}

function splitWikiAlias(raw: string): { target: string; alias?: string } {
    const index = raw.indexOf('|');
    if (index === -1) {
        return { target: raw.trim() };
    }
    const target = raw.slice(0, index).trim();
    const alias = raw.slice(index + 1).trim();
    return alias ? { target, alias } : { target };
}

function stripCodeBlocks(source: string): string {
    return source.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

function stripFrontmatterBlock(source: string): string {
    const match = FRONTMATTER_RE.exec(source);
    return match ? source.slice(match[0].length) : source;
}

function slugifyHeading(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-');
}

function stripHeadingTarget(target: string): string {
    const headingIndex = target.indexOf('#');
    return (headingIndex === -1 ? target : target.slice(0, headingIndex)).trim();
}

function extractTagsFromText(source: string): string[] {
    const found = new Set<string>();
    const cleaned = stripCodeBlocks(source);
    TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_RE.exec(cleaned))) {
        found.add(match[2]);
    }
    return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function extractHeadingsFromText(source: string): WebSupportWikiGraphHeading[] {
    const headings: WebSupportWikiGraphHeading[] = [];
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const match = HEADING_RE.exec(lines[index]);
        if (!match) {
            continue;
        }
        const text = match[2].replace(/\s+#+$/, '').trim();
        if (!text) {
            continue;
        }
        headings.push({
            level: match[1].length,
            text,
            slug: slugifyHeading(text),
            line: index + 1,
        });
    }
    return headings;
}

function extractWikiLinks(source: string): ExtractedWikiLink[] {
    const links: ExtractedWikiLink[] = [];
    const cleaned = stripCodeBlocks(source);
    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(cleaned))) {
        const inner = match[2].trim();
        if (!inner) {
            continue;
        }
        const { target, alias } = splitWikiAlias(inner);
        if (!target) {
            continue;
        }
        links.push({
            target,
            alias,
            isEmbed: match[1] === '!',
            type: 'wikilink',
        });
    }
    return links;
}

function splitFrontmatterListValue(raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed) {
        return [];
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed
            .slice(1, -1)
            .split(',')
            .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
    }
    return [trimmed.replace(/^['"]|['"]$/g, '')].filter(Boolean);
}

function extractFrontmatterRelationLinks(source: string): ExtractedWikiLink[] {
    const match = FRONTMATTER_RE.exec(source);
    if (!match) {
        return [];
    }

    const links: ExtractedWikiLink[] = [];
    const lines = match[1].split(/\r?\n/);
    let activeRelationKey: string | null = null;

    const collectItem = (item: string): void => {
        const trimmed = item.trim();
        if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
            return;
        }

        let hadWikiLink = false;
        WIKILINK_RE.lastIndex = 0;
        let wikiMatch: RegExpExecArray | null;
        while ((wikiMatch = WIKILINK_RE.exec(trimmed))) {
            const inner = wikiMatch[2].trim();
            if (!inner) {
                continue;
            }
            const { target, alias } = splitWikiAlias(inner);
            if (!target) {
                continue;
            }
            hadWikiLink = true;
            links.push({
                target,
                alias,
                isEmbed: wikiMatch[1] === '!',
                type: 'frontmatter',
            });
        }
        if (hadWikiLink) {
            return;
        }
        links.push({
            target: trimmed,
            isEmbed: false,
            type: 'frontmatter',
        });
    };

    for (const line of lines) {
        const keyMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (keyMatch) {
            const key = keyMatch[1].toLowerCase();
            const value = keyMatch[2].trim();
            activeRelationKey = FRONTMATTER_RELATION_KEYS.has(key) ? key : null;
            if (!activeRelationKey) {
                continue;
            }
            for (const item of splitFrontmatterListValue(value)) {
                collectItem(item);
            }
            continue;
        }

        if (!activeRelationKey) {
            continue;
        }
        const listMatch = /^\s*-\s+(.+)$/.exec(line);
        if (!listMatch) {
            continue;
        }
        for (const item of splitFrontmatterListValue(listMatch[1])) {
            collectItem(item);
        }
    }

    return links;
}

function dedupeGraphLinks(links: ExtractedWikiLink[]): ExtractedWikiLink[] {
    const seen = new Set<string>();
    const results: ExtractedWikiLink[] = [];
    for (const link of links) {
        const key = `${link.type}:${link.isEmbed ? '!' : ''}:${link.target}:${link.alias || ''}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        results.push(link);
    }
    return results;
}

async function statRegularFile(
    absPath: string,
    rootReal?: string,
): Promise<{ sizeBytes: number; updatedAtMs: number } | null> {
    let lstat;
    try {
        lstat = await fsPromises.lstat(absPath);
    } catch (error) {
        if (isNotFoundError(error)) {
            return null;
        }
        throw error;
    }

    if (lstat.isSymbolicLink()) {
        throw new Error('路径非法：不允许符号链接文件');
    }
    if (!lstat.isFile()) {
        throw new Error('路径非法：目标不是普通文件');
    }
    if (lstat.nlink > 1) {
        throw new Error('路径非法：不允许硬链接文件');
    }

    const realPath = await fsPromises.realpath(absPath).catch(() => absPath);
    if (rootReal && !isPathInsideDir(realPath, rootReal)) {
        throw new Error('路径非法：目标超出根目录');
    }
    const stat = await fsPromises.stat(realPath);
    if (!stat.isFile()) {
        throw new Error('路径非法：目标不是普通文件');
    }
    if (stat.nlink > 1) {
        throw new Error('路径非法：不允许硬链接文件');
    }

    return {
        sizeBytes: stat.size,
        updatedAtMs: Math.floor(stat.mtimeMs),
    };
}

async function resolvePathWithinRoot(rootPath: string, relativePath: string): Promise<{ rootReal: string; absPath: string }> {
    const rootReal = await resolveRootPath(rootPath);
    const absPath = path.resolve(rootReal, relativePath);
    if (!isPathInsideDir(absPath, rootReal)) {
        throw new Error('路径非法：超出根目录');
    }
    return { rootReal, absPath };
}

async function resolveSkillRoot(params: {
    skillsRoot: string;
    skillDir: string;
}): Promise<{ skillDir: string; skillsRootReal: string; skillRootPath: string; exists: boolean }> {
    const skillDir = normalizeSkillDirName(params.skillDir);
    const { rootReal: skillsRootReal, absPath: skillRootPath } = await resolvePathWithinRoot(params.skillsRoot, skillDir);

    let lstat;
    try {
        lstat = await fsPromises.lstat(skillRootPath);
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                skillDir,
                skillsRootReal,
                skillRootPath,
                exists: false,
            };
        }
        throw error;
    }

    if (lstat.isSymbolicLink()) {
        throw new Error('路径非法：skill 目录不允许符号链接');
    }
    if (!lstat.isDirectory()) {
        throw new Error('路径非法：skill 不是目录');
    }

    const realPath = await fsPromises.realpath(skillRootPath).catch(() => skillRootPath);
    if (!isPathInsideDir(realPath, skillsRootReal)) {
        throw new Error('路径非法：skill 目录超出根目录');
    }

    return {
        skillDir,
        skillsRootReal,
        skillRootPath: realPath,
        exists: true,
    };
}

async function ensureSafeParentDir(rootReal: string, absFilePath: string): Promise<void> {
    const relativeDir = path.relative(rootReal, path.dirname(absFilePath)).replace(/\\/g, '/');
    if (!relativeDir || relativeDir === '.') {
        return;
    }

    const segments = relativeDir.split('/').filter(Boolean);
    let currentDir = rootReal;
    for (const segment of segments) {
        currentDir = path.join(currentDir, segment);
        let lstat;
        try {
            lstat = await fsPromises.lstat(currentDir);
        } catch (error) {
            if (!isNotFoundError(error)) {
                throw error;
            }
            await fsPromises.mkdir(currentDir);
            continue;
        }

        if (lstat.isSymbolicLink()) {
            throw new Error('路径非法：父目录包含符号链接');
        }
        if (!lstat.isDirectory()) {
            throw new Error('路径非法：父路径不是目录');
        }
        const realPath = await fsPromises.realpath(currentDir).catch(() => currentDir);
        if (!isPathInsideDir(realPath, rootReal)) {
            throw new Error('路径非法：父目录超出根目录');
        }
    }
}

async function atomicWriteUtf8(absPath: string, content: string): Promise<void> {
    const tempPath = path.join(path.dirname(absPath), `.${path.basename(absPath)}.${process.pid}.${randomUUID()}.tmp`);
    await fsPromises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
        await fsPromises.rename(tempPath, absPath);
    } finally {
        await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

async function readTextFileContent(absPath: string, maxBytes: number): Promise<string> {
    const buffer = await fsPromises.readFile(absPath);
    if (buffer.length > maxBytes) {
        throw new Error(`文件过大，超过 ${maxBytes} 字节限制`);
    }
    if (buffer.includes(0)) {
        throw new Error('暂不支持读取二进制文件');
    }
    return buffer.toString('utf8');
}

export async function listSkillMarkdownFiles(skillsRoot: string): Promise<WebSkillFileSummary[]> {
    const rootReal = await resolveRootPath(skillsRoot);
    let entries;
    try {
        entries = await fsPromises.readdir(rootReal, { withFileTypes: true });
    } catch (error) {
        if (isNotFoundError(error)) {
            return [];
        }
        throw error;
    }

    const results: WebSkillFileSummary[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        if (!SKILL_DIR_NAME_RE.test(entry.name)) {
            continue;
        }
        const absPath = path.join(rootReal, entry.name, SKILL_MARKDOWN_FILE);
        try {
            const meta = await statRegularFile(absPath, rootReal);
            if (!meta) {
                continue;
            }
            results.push({
                skillDir: entry.name,
                exists: true,
                absPath,
                sizeBytes: meta.sizeBytes,
                updatedAtMs: meta.updatedAtMs,
            });
        } catch {
            continue;
        }
    }

    return results.sort((a, b) => a.skillDir.localeCompare(b.skillDir));
}

export async function listSkillFiles(params: {
    skillsRoot: string;
    skillDir: string;
}): Promise<WebSkillFileTreeResult> {
    const skill = await resolveSkillRoot(params);
    if (!skill.exists) {
        return {
            exists: false,
            skillDir: skill.skillDir,
            skillRootPath: skill.skillRootPath,
            tree: [],
            fileCount: 0,
            directoryCount: 0,
        };
    }

    let nodeCount = 0;
    let fileCount = 0;
    let directoryCount = 0;

    const walk = async (dirPath: string, relDir: string): Promise<WebSkillFileTreeNode[]> => {
        const children = await fsPromises.readdir(dirPath, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        const nodes: WebSkillFileTreeNode[] = [];

        for (const child of children) {
            if (nodeCount >= MAX_SKILL_TREE_ENTRIES) {
                throw new Error(`skill 文件数过多，超过 ${MAX_SKILL_TREE_ENTRIES} 条目限制`);
            }

            const childRelPath = relDir ? `${relDir}/${child.name}` : child.name;
            const childAbsPath = path.join(dirPath, child.name);
            const childLstat = await fsPromises.lstat(childAbsPath);
            if (childLstat.isSymbolicLink()) {
                continue;
            }

            const realPath = await fsPromises.realpath(childAbsPath).catch(() => childAbsPath);
            if (!isPathInsideDir(realPath, skill.skillRootPath)) {
                continue;
            }

            if (childLstat.isDirectory()) {
                directoryCount += 1;
                nodeCount += 1;
                const childrenNodes = await walk(realPath, childRelPath);
                nodes.push({
                    path: childRelPath,
                    name: child.name,
                    kind: 'directory',
                    children: childrenNodes,
                });
                continue;
            }

            if (!childLstat.isFile()) {
                continue;
            }
            if (childLstat.nlink > 1) {
                continue;
            }

            fileCount += 1;
            nodeCount += 1;
            nodes.push({
                path: childRelPath,
                name: child.name,
                kind: 'file',
                sizeBytes: childLstat.size,
                updatedAtMs: Math.floor(childLstat.mtimeMs),
            });
        }

        return nodes;
    };

    const tree = await walk(skill.skillRootPath, '');

    return {
        exists: true,
        skillDir: skill.skillDir,
        skillRootPath: skill.skillRootPath,
        tree,
        fileCount,
        directoryCount,
    };
}

export async function readSkillFile(params: {
    skillsRoot: string;
    skillDir: string;
    relativePath?: string;
}): Promise<WebManagedFileReadResult & { skillDir: string; relativePath: string }> {
    const skillDir = normalizeSkillDirName(params.skillDir);
    const relativePath = normalizeSkillFileRelPath(params.relativePath);
    const targetPath = normalizeSafeRelativePath(`${skillDir}/${relativePath}`);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.skillsRoot, targetPath);
    const meta = await statRegularFile(absPath, rootReal);
    if (!meta) {
        return {
            exists: false,
            absPath,
            skillDir,
            relativePath,
        };
    }

    const content = await readTextFileContent(absPath, MAX_SKILL_TEXT_FILE_BYTES);
    return {
        exists: true,
        absPath,
        skillDir,
        relativePath,
        content,
        sizeBytes: meta.sizeBytes,
        updatedAtMs: meta.updatedAtMs,
    };
}

export async function writeSkillFile(params: {
    skillsRoot: string;
    skillDir: string;
    relativePath?: string;
    content: string;
}): Promise<WebManagedFileReadResult & { skillDir: string; relativePath: string }> {
    const skillDir = normalizeSkillDirName(params.skillDir);
    const relativePath = normalizeSkillFileRelPath(params.relativePath);
    const targetPath = normalizeSafeRelativePath(`${skillDir}/${relativePath}`);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.skillsRoot, targetPath);
    const bytes = Buffer.byteLength(params.content, 'utf8');
    if (bytes > MAX_SKILL_TEXT_FILE_BYTES) {
        throw new Error(`文件过大，超过 ${MAX_SKILL_TEXT_FILE_BYTES} 字节限制`);
    }

    await fsPromises.mkdir(rootReal, { recursive: true });
    await ensureSafeParentDir(rootReal, absPath);
    await atomicWriteUtf8(absPath, params.content);
    const meta = await statRegularFile(absPath, rootReal);
    return {
        exists: true,
        absPath,
        skillDir,
        relativePath,
        content: params.content,
        sizeBytes: meta?.sizeBytes,
        updatedAtMs: meta?.updatedAtMs,
    };
}

export async function readSkillMarkdownFile(params: {
    skillsRoot: string;
    skillDir: string;
}): Promise<WebManagedFileReadResult> {
    const result = await readSkillFile({
        skillsRoot: params.skillsRoot,
        skillDir: params.skillDir,
        relativePath: SKILL_MARKDOWN_FILE,
    });
    return {
        exists: result.exists,
        absPath: result.absPath,
        content: result.content,
        sizeBytes: result.sizeBytes,
        updatedAtMs: result.updatedAtMs,
    };
}

export async function writeSkillMarkdownFile(params: {
    skillsRoot: string;
    skillDir: string;
    content: string;
}): Promise<WebManagedFileReadResult> {
    const result = await writeSkillFile({
        skillsRoot: params.skillsRoot,
        skillDir: params.skillDir,
        relativePath: SKILL_MARKDOWN_FILE,
        content: params.content,
    });
    return {
        exists: result.exists,
        absPath: result.absPath,
        content: result.content,
        sizeBytes: result.sizeBytes,
        updatedAtMs: result.updatedAtMs,
    };
}

export async function readMemoryMarkdownFile(params: {
    workspaceRoot: string;
    relativePath?: string;
}): Promise<WebManagedFileReadResult & { relativePath: string }> {
    const relativePath = normalizeMemoryRelPath(params.relativePath);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.workspaceRoot, relativePath);
    const meta = await statRegularFile(absPath, rootReal);
    if (!meta) {
        return {
            exists: false,
            absPath,
            relativePath,
        };
    }
    const content = await fsPromises.readFile(absPath, 'utf8');
    return {
        exists: true,
        absPath,
        relativePath,
        content,
        sizeBytes: meta.sizeBytes,
        updatedAtMs: meta.updatedAtMs,
    };
}

export async function writeMemoryMarkdownFile(params: {
    workspaceRoot: string;
    relativePath?: string;
    content: string;
}): Promise<WebManagedFileReadResult & { relativePath: string }> {
    const relativePath = normalizeMemoryRelPath(params.relativePath);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.workspaceRoot, relativePath);
    await fsPromises.mkdir(rootReal, { recursive: true });
    await ensureSafeParentDir(rootReal, absPath);
    await atomicWriteUtf8(absPath, params.content);
    const meta = await statRegularFile(absPath, rootReal);
    return {
        exists: true,
        absPath,
        relativePath,
        content: params.content,
        sizeBytes: meta?.sizeBytes,
        updatedAtMs: meta?.updatedAtMs,
    };
}

export async function listWorkspaceFiles(params: {
    rootPath: string;
}): Promise<WebWorkspaceFileTreeResult> {
    const rootPath = await resolveRootPath(params.rootPath);
    let rootLstat;
    try {
        rootLstat = await fsPromises.lstat(rootPath);
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                exists: false,
                rootPath,
                tree: [],
                fileCount: 0,
                directoryCount: 0,
            };
        }
        throw error;
    }

    if (rootLstat.isSymbolicLink()) {
        throw new Error('路径非法：根目录不允许符号链接');
    }
    if (!rootLstat.isDirectory()) {
        throw new Error('路径非法：根路径不是目录');
    }

    const rootReal = await fsPromises.realpath(rootPath).catch(() => rootPath);
    let nodeCount = 0;
    let fileCount = 0;
    let directoryCount = 0;

    const walk = async (dirPath: string, relDir: string): Promise<WebWorkspaceFileTreeNode[]> => {
        const children = await fsPromises.readdir(dirPath, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        const nodes: WebWorkspaceFileTreeNode[] = [];

        for (const child of children) {
            if (shouldSkipTreeEntry(child.name)) {
                continue;
            }
            if (nodeCount >= MAX_WORKSPACE_TREE_ENTRIES) {
                throw new Error(`目录文件数过多，超过 ${MAX_WORKSPACE_TREE_ENTRIES} 条目限制`);
            }

            const childRelPath = relDir ? `${relDir}/${child.name}` : child.name;
            const childAbsPath = path.join(dirPath, child.name);
            const childLstat = await fsPromises.lstat(childAbsPath);
            if (childLstat.isSymbolicLink()) {
                continue;
            }

            const realPath = await fsPromises.realpath(childAbsPath).catch(() => childAbsPath);
            if (!isPathInsideDir(realPath, rootReal)) {
                continue;
            }

            if (childLstat.isDirectory()) {
                directoryCount += 1;
                nodeCount += 1;
                const childrenNodes = await walk(realPath, childRelPath);
                nodes.push({
                    path: childRelPath,
                    name: child.name,
                    kind: 'directory',
                    children: childrenNodes,
                });
                continue;
            }

            if (!childLstat.isFile()) {
                continue;
            }
            if (childLstat.nlink > 1) {
                continue;
            }

            fileCount += 1;
            nodeCount += 1;
            nodes.push({
                path: childRelPath,
                name: child.name,
                kind: 'file',
                sizeBytes: childLstat.size,
                updatedAtMs: Math.floor(childLstat.mtimeMs),
            });
        }

        return nodes;
    };

    const tree = await walk(rootReal, '');
    return {
        exists: true,
        rootPath: rootReal,
        tree,
        fileCount,
        directoryCount,
    };
}

export async function readWorkspaceTextFile(params: {
    rootPath: string;
    relativePath: string;
}): Promise<WebManagedFileReadResult & { relativePath: string }> {
    const relativePath = normalizeWorkspaceTextRelPath(params.relativePath);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.rootPath, relativePath);
    const meta = await statRegularFile(absPath, rootReal);
    if (!meta) {
        return {
            exists: false,
            absPath,
            relativePath,
        };
    }

    const content = await readTextFileContent(absPath, MAX_WORKSPACE_TEXT_FILE_BYTES);
    return {
        exists: true,
        absPath,
        relativePath,
        content,
        sizeBytes: meta.sizeBytes,
        updatedAtMs: meta.updatedAtMs,
    };
}

export async function writeWorkspaceTextFile(params: {
    rootPath: string;
    relativePath: string;
    content: string;
}): Promise<WebManagedFileReadResult & { relativePath: string }> {
    const relativePath = normalizeWorkspaceTextRelPath(params.relativePath);
    const { rootReal, absPath } = await resolvePathWithinRoot(params.rootPath, relativePath);
    const bytes = Buffer.byteLength(params.content, 'utf8');
    if (bytes > MAX_WORKSPACE_TEXT_FILE_BYTES) {
        throw new Error(`文件过大，超过 ${MAX_WORKSPACE_TEXT_FILE_BYTES} 字节限制`);
    }

    await fsPromises.mkdir(rootReal, { recursive: true });
    await ensureSafeParentDir(rootReal, absPath);
    await atomicWriteUtf8(absPath, params.content);
    const meta = await statRegularFile(absPath, rootReal);
    return {
        exists: true,
        absPath,
        relativePath,
        content: params.content,
        sizeBytes: meta?.sizeBytes,
        updatedAtMs: meta?.updatedAtMs,
    };
}

async function collectWorkspaceMarkdownFiles(rootPath: string): Promise<{
    exists: boolean;
    rootPath: string;
    files: WorkspaceMarkdownRecord[];
}> {
    const resolvedRoot = await resolveRootPath(rootPath);
    let rootLstat;
    try {
        rootLstat = await fsPromises.lstat(resolvedRoot);
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                exists: false,
                rootPath: resolvedRoot,
                files: [],
            };
        }
        throw error;
    }

    if (rootLstat.isSymbolicLink()) {
        throw new Error('路径非法：根目录不允许符号链接');
    }
    if (!rootLstat.isDirectory()) {
        throw new Error('路径非法：根路径不是目录');
    }

    const rootReal = await fsPromises.realpath(resolvedRoot).catch(() => resolvedRoot);
    const files: WorkspaceMarkdownRecord[] = [];
    let nodeCount = 0;

    const walk = async (dirPath: string, relDir: string): Promise<void> => {
        const children = await fsPromises.readdir(dirPath, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));

        for (const child of children) {
            if (shouldSkipTreeEntry(child.name)) {
                continue;
            }
            if (nodeCount >= MAX_WORKSPACE_TREE_ENTRIES) {
                throw new Error(`目录文件数过多，超过 ${MAX_WORKSPACE_TREE_ENTRIES} 条目限制`);
            }

            const childRelPath = relDir ? `${relDir}/${child.name}` : child.name;
            const childAbsPath = path.join(dirPath, child.name);
            const childLstat = await fsPromises.lstat(childAbsPath);
            if (childLstat.isSymbolicLink()) {
                continue;
            }

            const realPath = await fsPromises.realpath(childAbsPath).catch(() => childAbsPath);
            if (!isPathInsideDir(realPath, rootReal)) {
                continue;
            }

            if (childLstat.isDirectory()) {
                nodeCount += 1;
                await walk(realPath, childRelPath);
                continue;
            }

            if (!childLstat.isFile() || childLstat.nlink > 1) {
                continue;
            }

            nodeCount += 1;
            if (!WORKSPACE_MARKDOWN_FILE_RE.test(child.name)) {
                continue;
            }

            const content = await readTextFileContent(realPath, MAX_WORKSPACE_TEXT_FILE_BYTES);
            files.push({
                path: childRelPath,
                name: child.name,
                basename: stripExtension(child.name),
                dir: getPosixDirname(childRelPath),
                absPath: realPath,
                sizeBytes: childLstat.size,
                updatedAtMs: Math.floor(childLstat.mtimeMs),
                content,
            });
        }
    };

    await walk(rootReal, '');
    return {
        exists: true,
        rootPath: rootReal,
        files,
    };
}

function resolveWikiGraphTarget(params: {
    target: string;
    fromPath: string;
    notePaths: Set<string>;
    basenameIndex: Map<string, string[]>;
}): string | null {
    const rawName = stripHeadingTarget(params.target);
    if (!rawName) {
        return null;
    }

    const normalized = normalizeContentPath(rawName);
    if (!normalized) {
        return null;
    }

    const exactCandidates = [
        normalized,
        `${normalized}.md`,
        `${normalized}.markdown`,
    ];
    for (const candidate of exactCandidates) {
        if (params.notePaths.has(candidate)) {
            return candidate;
        }
    }

    const fromDir = getPosixDirname(params.fromPath);
    const relative = fromDir ? `${fromDir}/${normalized}` : normalized;
    const relativeCandidates = [
        relative,
        `${relative}.md`,
        `${relative}.markdown`,
    ];
    for (const candidate of relativeCandidates) {
        if (params.notePaths.has(candidate)) {
            return candidate;
        }
    }

    const wantedBase = stripExtension(getPosixBasename(normalized)).toLowerCase();
    const matches = params.basenameIndex.get(wantedBase);
    if (!matches?.length) {
        return null;
    }
    return matches.find((candidate) => getPosixDirname(candidate) === fromDir) || matches[0] || null;
}

export async function buildSupportWikiGraph(params: {
    rootPath: string;
}): Promise<WebSupportWikiGraphResult> {
    const collected = await collectWorkspaceMarkdownFiles(params.rootPath);
    const indexedAt = Date.now();
    if (!collected.exists) {
        return {
            exists: false,
            rootPath: collected.rootPath,
            summary: {
                nodeCount: 0,
                edgeCount: 0,
                noteCount: 0,
                unresolvedCount: 0,
                indexedAt,
            },
            nodes: [],
            edges: [],
        };
    }

    const notePaths = new Set(collected.files.map((item) => item.path));
    const basenameIndex = new Map<string, string[]>();
    const nodeMap = new Map<string, WebSupportWikiGraphNode>();

    for (const file of collected.files) {
        const basenameKey = stripExtension(getPosixBasename(file.path)).toLowerCase();
        const matches = basenameIndex.get(basenameKey) || [];
        matches.push(file.path);
        basenameIndex.set(basenameKey, matches);

        nodeMap.set(file.path, {
            id: file.path,
            path: file.path,
            label: file.basename,
            kind: 'note',
            dir: file.dir,
            degree: 0,
            tags: extractTagsFromText(stripFrontmatterBlock(file.content)),
            headings: extractHeadingsFromText(stripFrontmatterBlock(file.content)),
            sizeBytes: file.sizeBytes,
            updatedAtMs: file.updatedAtMs,
        });
    }

    const edges: WebSupportWikiGraphEdge[] = [];
    const edgeKeys = new Set<string>();

    for (const file of collected.files) {
        const links = dedupeGraphLinks([
            ...extractWikiLinks(stripFrontmatterBlock(file.content)),
            ...extractFrontmatterRelationLinks(file.content),
        ]);

        for (const link of links) {
            if (link.isEmbed) {
                continue;
            }

            const rawTarget = stripHeadingTarget(link.target);
            if (!rawTarget) {
                continue;
            }

            const resolvedTarget = resolveWikiGraphTarget({
                target: rawTarget,
                fromPath: file.path,
                notePaths,
                basenameIndex,
            });
            const target = resolvedTarget || `::unresolved::${normalizeContentPath(rawTarget).toLowerCase()}`;
            if (!target || target === file.path) {
                continue;
            }

            if (!resolvedTarget && !nodeMap.has(target)) {
                nodeMap.set(target, {
                    id: target,
                    label: rawTarget,
                    kind: 'unresolved',
                    degree: 0,
                });
            }

            const edgeKey = `${file.path}\u0000${target}\u0000${link.type}\u0000${rawTarget}`;
            if (edgeKeys.has(edgeKey)) {
                continue;
            }
            edgeKeys.add(edgeKey);

            edges.push({
                source: file.path,
                target,
                type: link.type,
                targetRaw: link.target,
                alias: link.alias,
                resolved: Boolean(resolvedTarget),
            });

            const sourceNode = nodeMap.get(file.path);
            const targetNode = nodeMap.get(target);
            if (sourceNode) {
                sourceNode.degree += 1;
            }
            if (targetNode) {
                targetNode.degree += 1;
            }
        }
    }

    const nodes = Array.from(nodeMap.values()).sort((a, b) => a.id.localeCompare(b.id));
    edges.sort((a, b) => `${a.source}\u0000${a.target}`.localeCompare(`${b.source}\u0000${b.target}`));
    const unresolvedCount = nodes.filter((item) => item.kind === 'unresolved').length;

    return {
        exists: true,
        rootPath: collected.rootPath,
        summary: {
            nodeCount: nodes.length,
            edgeCount: edges.length,
            noteCount: collected.files.length,
            unresolvedCount,
            indexedAt,
        },
        nodes,
        edges,
    };
}
