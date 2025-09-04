import { Notice } from 'obsidian';
import { GitHubClient, GitHubFile } from '../github-client';
import { LocalSnippetsManager, LocalSnippet } from '../local-snippets-manager';
import { HashUtils } from './hash-utils';

export interface IncrementalSyncResult {
    success: boolean;
    message: string;
    details: {
        uploaded: string[];
        skipped: string[];
        updated: string[];
        conflicts: string[];
        totalProcessed: number;
        totalTime: number;
    };
}

export interface FileComparison {
    filename: string;
    localHash: string;
    cloudHash: string;
    localContent?: string;
    cloudContent?: string;
    needsSync: boolean;
    isConflict: boolean;
    action: 'upload' | 'update' | 'skip' | 'conflict';
}

/**
 * 增量同步管理器 - 基于文件哈希值的真正增量同步
 */
export class IncrementalSyncManager {
    private githubClient: GitHubClient;
    private localManager: LocalSnippetsManager;
    private hashCache: Map<string, { hash: string, timestamp: number }> = new Map();
    private readonly CACHE_EXPIRY = 5 * 60 * 1000; // 5分钟缓存过期

    constructor(githubClient: GitHubClient, localManager: LocalSnippetsManager) {
        this.githubClient = githubClient;
        this.localManager = localManager;
    }

    /**
     * 标准化文件内容，确保哈希计算的一致性
     */
    private normalizeContent(content: string): string {
        // 与 HashUtils.calculateHash 使用相同的标准化逻辑
        return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    }

    /**
     * 执行增量同步到云端
     */
    async syncToCloud(options: { 
        forceOverwrite?: boolean;
        selectedFiles?: string[];
        useSecureHash?: boolean;
    } = {}): Promise<IncrementalSyncResult> {
        const startTime = Date.now();
        const result: IncrementalSyncResult = {
            success: false,
            message: '',
            details: {
                uploaded: [],
                skipped: [],
                updated: [],
                conflicts: [],
                totalProcessed: 0,
                totalTime: 0
            }
        };

        try {
            console.log('🔄 开始增量同步分析...');
            
            // 1. 获取本地文件列表
            const localSnippets = await this.localManager.getSnippetsList();
            const cssSnippets = localSnippets.filter(s => s.name.endsWith('.css'));
            
            // 2. 过滤选定的文件
            const targetSnippets = options.selectedFiles 
                ? cssSnippets.filter(s => options.selectedFiles!.includes(s.name))
                : cssSnippets;

            if (targetSnippets.length === 0) {
                result.message = '没有找到需要同步的CSS文件';
                result.success = true;
                return result;
            }

            // 3. 获取云端文件列表
            const cloudFiles = await this.githubClient.listFiles();
            
            // 4. 进行文件比较分析
            const comparisons = await this.analyzeFileComparisons(
                targetSnippets, 
                cloudFiles, 
                options.useSecureHash || false
            );

            console.log(`📊 文件分析完成：需要处理 ${comparisons.length} 个文件`);

            // 5. 处理文件同步
            for (const comparison of comparisons) {
                try {
                    await this.processSingleFileSync(comparison, options.forceOverwrite || false, result);
                } catch (error) {
                    console.error(`处理文件 ${comparison.filename} 时出错:`, error);
                    result.details.conflicts.push(comparison.filename);
                }
            }

            result.details.totalProcessed = comparisons.length;
            result.details.totalTime = Date.now() - startTime;

            // 6. 生成结果报告
            this.generateSyncReport(result);

            result.success = result.details.conflicts.length === 0;
            
            return result;

        } catch (error) {
            console.error('增量同步过程出错:', error);
            result.message = `同步失败: ${error instanceof Error ? error.message : '未知错误'}`;
            result.details.totalTime = Date.now() - startTime;
            return result;
        }
    }

    /**
     * 分析文件比较结果
     */
    private async analyzeFileComparisons(
        localSnippets: LocalSnippet[], 
        cloudFiles: GitHubFile[], 
        useSecureHash: boolean
    ): Promise<FileComparison[]> {
        const comparisons: FileComparison[] = [];

        for (const snippet of localSnippets) {
            const cloudFile = cloudFiles.find(f => f.name === snippet.name);
            
            // 标准化本地文件内容并重新计算哈希，确保与云端哈希计算方式完全一致
            const normalizedLocalContent = this.normalizeContent(snippet.content);
            const localHash = useSecureHash 
                ? HashUtils.calculateSecureHash(normalizedLocalContent)
                : HashUtils.calculateHash(normalizedLocalContent);

            if (!cloudFile) {
                // 云端不存在，需要上传
                comparisons.push({
                    filename: snippet.name,
                    localHash,
                    cloudHash: '',
                    localContent: snippet.content,
                    needsSync: true,
                    isConflict: false,
                    action: 'upload'
                });
            } else {
                // 云端存在，需要比较内容
                const cloudHash = await this.getCloudFileHash(cloudFile, useSecureHash);
                
                if (HashUtils.compareHash(localHash, cloudHash)) {
                    // 内容相同，跳过
                    comparisons.push({
                        filename: snippet.name,
                        localHash,
                        cloudHash,
                        needsSync: false,
                        isConflict: false,
                        action: 'skip'
                    });
                } else {
                    // 内容不同，需要更新
                    comparisons.push({
                        filename: snippet.name,
                        localHash,
                        cloudHash,
                        localContent: snippet.content,
                        needsSync: true,
                        isConflict: false,
                        action: 'update'
                    });
                }
            }
        }

        return comparisons;
    }

    /**
     * 获取云端文件的哈希值（带缓存）
     */
    private async getCloudFileHash(cloudFile: GitHubFile, useSecureHash: boolean): Promise<string> {
        const cacheKey = `${cloudFile.path}:${cloudFile.sha}:${useSecureHash}`;
        const cached = this.hashCache.get(cacheKey);
        
        // 检查缓存是否有效
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_EXPIRY) {
            return cached.hash;
        }

        try {
            // 下载云端文件内容并计算哈希
            const content = await this.githubClient.downloadFile(cloudFile.path);
            // 标准化内容确保与本地文件哈希计算一致
            const normalizedContent = this.normalizeContent(content);
            const hash = useSecureHash 
                ? HashUtils.calculateSecureHash(normalizedContent)
                : HashUtils.calculateHash(normalizedContent);
            
            // 更新缓存
            this.hashCache.set(cacheKey, { hash, timestamp: Date.now() });
            
            return hash;
        } catch (error) {
            console.error(`获取云端文件 ${cloudFile.path} 哈希失败:`, error);
            throw error;
        }
    }

    /**
     * 处理单个文件的同步
     */
    private async processSingleFileSync(
        comparison: FileComparison, 
        forceOverwrite: boolean, 
        result: IncrementalSyncResult
    ): Promise<void> {
        const { filename, action, localContent } = comparison;

        switch (action) {
            case 'skip':
                result.details.skipped.push(filename);
                console.log(`⏭️ 跳过同步（内容相同）: ${filename}`);
                break;

            case 'upload':
                try {
                    const success = await this.githubClient.uploadFile(
                        filename,
                        localContent!,
                        `Add new CSS snippet: ${filename}`
                    );
                    
                    if (success) {
                        result.details.uploaded.push(filename);
                        console.log(`⬆️ 新文件上传成功: ${filename}`);
                    } else {
                        result.details.conflicts.push(filename);
                    }
                } catch (error) {
                    console.error(`上传新文件失败 ${filename}:`, error);
                    result.details.conflicts.push(filename);
                }
                break;

            case 'update':
                if (forceOverwrite) {
                    try {
                        const success = await this.githubClient.uploadFile(
                            filename,
                            localContent!,
                            `Update CSS snippet: ${filename} (incremental sync)`
                        );
                        
                        if (success) {
                            result.details.updated.push(filename);
                            console.log(`🔄 文件更新成功: ${filename}`);
                        } else {
                            result.details.conflicts.push(filename);
                        }
                    } catch (error) {
                        console.error(`更新文件失败 ${filename}:`, error);
                        result.details.conflicts.push(filename);
                    }
                } else {
                    // 标记为冲突，需要用户决定
                    result.details.conflicts.push(filename);
                    console.log(`⚠️ 检测到文件冲突: ${filename}`);
                }
                break;

            default:
                result.details.conflicts.push(filename);
                console.warn(`未知的同步动作: ${action} for ${filename}`);
        }
    }

    /**
     * 生成同步报告
     */
    private generateSyncReport(result: IncrementalSyncResult): void {
        const { details } = result;
        const parts: string[] = [];

        if (details.uploaded.length > 0) {
            parts.push(`新增 ${details.uploaded.length} 个文件`);
        }
        
        if (details.updated.length > 0) {
            parts.push(`更新 ${details.updated.length} 个文件`);
        }
        
        if (details.skipped.length > 0) {
            parts.push(`跳过 ${details.skipped.length} 个相同文件`);
        }

        if (details.conflicts.length > 0) {
            parts.push(`${details.conflicts.length} 个文件有冲突`);
        }

        const timeStr = details.totalTime > 1000 
            ? `${(details.totalTime / 1000).toFixed(1)}秒`
            : `${details.totalTime}毫秒`;

        result.message = parts.length > 0 
            ? `${parts.join('，')}，耗时 ${timeStr}`
            : `处理 ${details.totalProcessed} 个文件，耗时 ${timeStr}`;
    }

    /**
     * 清除哈希缓存
     */
    clearHashCache(): void {
        this.hashCache.clear();
        console.log('🧹 哈希缓存已清除');
    }

    /**
     * 获取详细的文件比较报告（用于调试）
     */
    async getDetailedComparisonReport(useSecureHash: boolean = false): Promise<FileComparison[]> {
        try {
            const localSnippets = await this.localManager.getSnippetsList();
            const cssSnippets = localSnippets.filter(s => s.name.endsWith('.css'));
            const cloudFiles = await this.githubClient.listFiles();
            
            return await this.analyzeFileComparisons(cssSnippets, cloudFiles, useSecureHash);
        } catch (error) {
            console.error('生成详细比较报告失败:', error);
            return [];
        }
    }
}
