import { Notice } from 'obsidian';
import { GitHubClient, GitHubFile } from './github-client';
import { LocalSnippetsManager, LocalSnippet } from './local-snippets-manager';
import { HashUtils } from './utils/hash-utils';
import { IncrementalSyncManager, IncrementalSyncResult } from './utils/incremental-sync-manager';

export interface SyncResult {
    success: boolean;
    message: string;
    conflicts?: string[];
    details?: any;
}

export interface SyncOptions {
    forceOverwrite?: boolean;
    selectedFiles?: string[];
    useSecureHash?: boolean;
}

export class SyncManager {
    private githubClient: GitHubClient;
    private localManager: LocalSnippetsManager;
    private incrementalSyncManager: IncrementalSyncManager;

    constructor(githubClient: GitHubClient, localManager: LocalSnippetsManager) {
        this.githubClient = githubClient;
        this.localManager = localManager;
        this.incrementalSyncManager = new IncrementalSyncManager(githubClient, localManager);
    }

    /**
     * 验证上传下载的编码一致性（调试用）
     */
    async verifyUploadDownloadConsistency(content: string): Promise<{
        originalHash: string,
        downloadedHash: string,
        consistent: boolean
    }> {
        const testFilename = '_test_encoding_consistency.css';
        
        try {
            // 计算原始内容的哈希
            const normalizedOriginal = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
            const originalHash = HashUtils.calculateHash(normalizedOriginal);
            
            // 上传内容
            await this.githubClient.uploadFile(testFilename, content, 'Test encoding consistency');
            
            // 下载内容
            const downloadedContent = await this.githubClient.downloadFile(testFilename);
            
            // 计算下载内容的哈希
            const normalizedDownloaded = downloadedContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
            const downloadedHash = HashUtils.calculateHash(normalizedDownloaded);
            
            // 清理测试文件
            try {
                await this.githubClient.deleteFile(testFilename, 'Clean up test file');
            } catch (error) {
                console.warn('Failed to clean up test file:', error);
            }
            
            return {
                originalHash,
                downloadedHash,
                consistent: originalHash === downloadedHash
            };
        } catch (error) {
            console.error('Error verifying upload/download consistency:', error);
            throw error;
        }
    }

    /**
     * 从云端同步到本地
     */
    async syncFromCloud(options: SyncOptions = {}): Promise<SyncResult> {
        try {
            // 获取云端文件列表
            const cloudFiles = await this.githubClient.listFiles();
            const localSnippets = await this.localManager.getSnippetsList();
            
            const conflicts: string[] = [];
            let syncedCount = 0;

            for (const cloudFile of cloudFiles) {
                const filename = cloudFile.name;
                
                // 如果指定了选择的文件，只同步这些文件
                if (options.selectedFiles && !options.selectedFiles.includes(filename)) {
                    continue;
                }

                // 检查是否存在冲突
                const localFile = localSnippets.find(s => s.name === filename);
                if (localFile && !options.forceOverwrite) {
                    // 比较修改时间或询问用户
                    conflicts.push(filename);
                    continue;
                }

                try {
                    // 下载文件内容
                    const content = await this.githubClient.downloadFile(cloudFile.path);
                    
                    // 写入本地
                    await this.localManager.writeSnippet(filename, content);
                    syncedCount++;
                    
                    console.log(`已下载: ${filename}`);
                } catch (error) {
                    console.error(`Error syncing ${filename}:`, error);
                }
            }

            if (conflicts.length > 0) {
                return {
                    success: false,
                    message: `同步完成，但有 ${conflicts.length} 个文件存在冲突`,
                    conflicts
                };
            }

            return {
                success: true,
                message: `成功同步 ${syncedCount} 个文件`
            };
        } catch (error) {
            console.error('Error syncing from cloud:', error);
            return {
                success: false,
                message: `同步失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 双向同步：先从云端同步到本地，然后将本地更改同步到云端
     */
    async bidirectionalSync(options: SyncOptions = {}): Promise<SyncResult> {
        try {
            // 第一步：从云端同步到本地
            console.log('开始双向同步：第一步 - 从云端同步到本地');
            const fromCloudResult = await this.syncFromCloud(options);
            
            if (!fromCloudResult.success && fromCloudResult.conflicts && fromCloudResult.conflicts.length > 0) {
                // 如果有冲突且不是强制覆盖模式，返回冲突信息
                if (!options.forceOverwrite) {
                    return {
                        success: false,
                        message: '检测到同步冲突，请手动解决冲突或使用强制覆盖模式',
                        conflicts: fromCloudResult.conflicts
                    };
                }
            }

            // 第二步：将本地更改同步到云端
            console.log('双向同步：第二步 - 将本地更改同步到云端');
            const toCloudResult = await this.syncToCloud(options);
            
            if (!toCloudResult.success) {
                return {
                    success: false,
                    message: `双向同步部分完成：云端到本地成功，但本地到云端失败 - ${toCloudResult.message}`
                };
            }

            // 合并结果
            const totalConflicts = [
                ...(fromCloudResult.conflicts || []),
                ...(toCloudResult.conflicts || [])
            ];

            return {
                success: true,
                message: '双向同步完成',
                conflicts: totalConflicts.length > 0 ? totalConflicts : undefined
            };

        } catch (error) {
            console.error('Error in bidirectional sync:', error);
            return {
                success: false,
                message: `双向同步失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 从本地同步到云端（增量同步，基于哈希值比较）
     * 新版本：使用专门的增量同步管理器
     */
    async syncToCloud(options: SyncOptions = {}): Promise<SyncResult> {
        try {
            console.log('🚀 启动基于哈希值的增量同步...');
            
            // 使用新的增量同步管理器
            const incrementalResult: IncrementalSyncResult = await this.incrementalSyncManager.syncToCloud({
                forceOverwrite: options.forceOverwrite,
                selectedFiles: options.selectedFiles,
                useSecureHash: options.useSecureHash || false
            });

            // 转换结果格式以保持兼容性
            const result: SyncResult = {
                success: incrementalResult.success,
                message: incrementalResult.message,
                details: incrementalResult.details
            };

            // 如果有冲突，添加到结果中
            if (incrementalResult.details.conflicts.length > 0) {
                result.conflicts = incrementalResult.details.conflicts;
            }

            // 记录详细信息
            const { details } = incrementalResult;
            console.log(`📊 增量同步完成统计:`);
            console.log(`  - 新增文件: ${details.uploaded.length}`);
            console.log(`  - 更新文件: ${details.updated.length}`);
            console.log(`  - 跳过文件: ${details.skipped.length}`);
            console.log(`  - 冲突文件: ${details.conflicts.length}`);
            console.log(`  - 总耗时: ${details.totalTime}ms`);

            return result;

        } catch (error) {
            console.error('增量同步过程出错:', error);
            return {
                success: false,
                message: `增量同步失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 传统同步方法（保持向后兼容性）
     * 逐步被新的增量同步替代
     */
    async syncToCloudLegacy(options: SyncOptions = {}): Promise<SyncResult> {
        try {
            // 获取本地文件列表（仅 .css 文件）
            const localSnippets = await this.localManager.getSnippetsList();
            const cssSnippets = localSnippets.filter(s => s.name.endsWith('.css'));
            
            // 获取云端文件列表
            const cloudFiles = await this.githubClient.listFiles();
            
            const conflicts: string[] = [];
            const needSync: LocalSnippet[] = [];
            const newFiles: LocalSnippet[] = [];
            let skippedCount = 0;

            for (const localSnippet of cssSnippets) {
                const filename = localSnippet.name;
                
                // 如果指定了选择的文件，只同步这些文件
                if (options.selectedFiles && !options.selectedFiles.includes(filename)) {
                    continue;
                }

                // 检查云端是否存在该文件
                const cloudFile = cloudFiles.find(f => f.name === filename);
                
                if (!cloudFile) {
                    // 云端不存在，需要上传新文件
                    newFiles.push(localSnippet);
                } else if (options.forceOverwrite) {
                    // 强制覆盖
                    needSync.push(localSnippet);
                } else {
                    // 进行增量检查：比较内容哈希
                    try {
                        const cloudContent = await this.githubClient.downloadFile(cloudFile.path);
                        const cloudHash = HashUtils.calculateHash(cloudContent);
                        
                        if (localSnippet.hash !== cloudHash) {
                            // 内容不同，需要同步
                            needSync.push(localSnippet);
                        } else {
                            // 内容相同，跳过
                            skippedCount++;
                            console.log(`跳过同步（内容相同）: ${filename}`);
                        }
                    } catch (error) {
                        console.warn(`无法比较文件 ${filename}:`, error);
                        conflicts.push(filename);
                    }
                }
            }

            // 上传新文件
            let syncedCount = 0;
            for (const snippet of newFiles) {
                try {
                    const success = await this.githubClient.uploadFile(
                        snippet.name,
                        snippet.content,
                        `Add new file: ${snippet.name}`
                    );
                    
                    if (success) {
                        syncedCount++;
                        console.log(`已上传新文件: ${snippet.name}`);
                    }
                } catch (error) {
                    console.error(`上传新文件失败 ${snippet.name}:`, error);
                    conflicts.push(snippet.name);
                }
            }

            // 更新已存在的文件
            for (const snippet of needSync) {
                try {
                    const success = await this.githubClient.uploadFile(
                        snippet.name,
                        snippet.content,
                        `Update ${snippet.name} (content changed)`
                    );
                    
                    if (success) {
                        syncedCount++;
                        console.log(`已更新: ${snippet.name}`);
                    }
                } catch (error) {
                    console.error(`更新文件失败 ${snippet.name}:`, error);
                    conflicts.push(snippet.name);
                }
            }

            // 返回结果
            const totalProcessed = newFiles.length + needSync.length + skippedCount;
            let message = `传统增量同步完成：`;
            
            if (syncedCount > 0) {
                message += `上传 ${syncedCount} 个文件，`;
            }
            if (skippedCount > 0) {
                message += `跳过 ${skippedCount} 个相同文件，`;
            }
            message += `共处理 ${totalProcessed} 个文件`;

            if (conflicts.length > 0) {
                return {
                    success: false,
                    message: `${message}，但有 ${conflicts.length} 个文件失败`,
                    conflicts
                };
            }

            return {
                success: true,
                message: message
            };
        } catch (error) {
            console.error('增量同步过程出错:', error);
            return {
                success: false,
                message: `增量同步失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 清除增量同步的哈希缓存
     */
    clearIncrementalSyncCache(): void {
        this.incrementalSyncManager.clearHashCache();
    }

    /**
     * 获取详细的文件比较报告（调试用）
     */
    async getDetailedComparisonReport(useSecureHash: boolean = false) {
        return await this.incrementalSyncManager.getDetailedComparisonReport(useSecureHash);
    }

    /**
     * 获取云端文件的内容哈希值（供UI显示使用，确保与增量同步一致）
     */
    async getCloudFileContentHash(file: GitHubFile, useSecureHash: boolean = false): Promise<string> {
        try {
            // 使用增量同步管理器的哈希计算逻辑，确保完全一致
            const cacheKey = `${file.path}:${file.sha}:${useSecureHash}`;
            const cached = this.incrementalSyncManager['hashCache'].get(cacheKey);
            
            // 检查缓存是否有效
            if (cached && (Date.now() - cached.timestamp) < this.incrementalSyncManager['CACHE_EXPIRY']) {
                return cached.hash;
            }

            // 下载云端文件内容并计算哈希
            const content = await this.githubClient.downloadFile(file.path);
            // 标准化内容，确保与本地文件哈希计算一致
            const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
            const hash = useSecureHash 
                ? HashUtils.calculateSecureHash(normalizedContent)
                : HashUtils.calculateHash(normalizedContent);
            
            // 更新缓存（使用增量同步管理器的缓存）
            this.incrementalSyncManager['hashCache'].set(cacheKey, { hash, timestamp: Date.now() });
            
            return hash;
        } catch (error) {
            console.error(`获取云端文件 ${file.path} 哈希失败:`, error);
            // 发生错误时返回Git SHA的前8位
            return file.sha.substring(0, 8);
        }
    }

    /**
     * 检查同步冲突
     */
    async checkConflicts(): Promise<{ local: string[], cloud: string[] }> {
        try {
            const [localSnippets, cloudFiles] = await Promise.all([
                this.localManager.getSnippetsList(),
                this.githubClient.listFiles()
            ]);

            const localFiles = localSnippets.map(s => s.name);
            const cloudFileNames = cloudFiles.map(f => f.name);

            const conflicts = {
                local: localFiles.filter(name => cloudFileNames.includes(name)),
                cloud: cloudFileNames.filter(name => localFiles.includes(name))
            };

            return conflicts;
        } catch (error) {
            console.error('Error checking conflicts:', error);
            return { local: [], cloud: [] };
        }
    }

    /**
     * 获取同步状态
     */
    async getSyncStatus(): Promise<{
        localCount: number;
        cloudCount: number;
        conflicts: number;
        lastSync: number;
    }> {
        try {
            const [localSnippets, cloudFiles] = await Promise.all([
                this.localManager.getSnippetsList(),
                this.githubClient.listFiles()
            ]);

            const conflicts = await this.checkConflicts();

            return {
                localCount: localSnippets.length,
                cloudCount: cloudFiles.length,
                conflicts: conflicts.local.length,
                lastSync: Date.now() // 使用当前时间作为最后同步时间
            };
        } catch (error) {
            console.error('Error getting sync status:', error);
            return {
                localCount: 0,
                cloudCount: 0,
                conflicts: 0,
                lastSync: 0
            };
        }
    }

    /**
     * 解决冲突 - 选择保留哪个版本
     */
    async resolveConflict(filename: string, keepVersion: 'local' | 'cloud'): Promise<boolean> {
        try {
            if (keepVersion === 'local') {
                // 保留本地版本，上传到云端
                const localSnippets = await this.localManager.getSnippetsList();
                const localSnippet = localSnippets.find(s => s.name === filename);
                
                if (localSnippet) {
                    return await this.githubClient.uploadFile(
                        filename,
                        localSnippet.content,
                        `Resolve conflict: keep local version of ${filename}`
                    );
                }
            } else {
                // 保留云端版本，下载到本地
                const content = await this.githubClient.downloadFile(filename);
                return await this.localManager.writeSnippet(filename, content);
            }
            
            return false;
        } catch (error) {
            console.error('Error resolving conflict:', error);
            return false;
        }
    }

    /**
     * 更新 GitHub 客户端凭据
     */
    updateGitHubCredentials(token: string, repoUrl: string) {
        this.githubClient.updateCredentials(token, repoUrl);
    }
}
