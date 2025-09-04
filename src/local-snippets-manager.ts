import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { HashUtils } from './utils/hash-utils';
import * as path from 'path';

export interface LocalSnippet {
    name: string;
    path: string;
    content: string;
    enabled: boolean;
    description?: string;
    lastModified: number;
    hash: string;
}

export class LocalSnippetsManager {
    private app: App;
    private snippetsPath: string;
    private settings: any;

    constructor(app: App, settings: any) {
        this.app = app;
        this.settings = settings;
        // Obsidian 的 CSS snippets 目录路径
        this.snippetsPath = '.obsidian/snippets';
    }

    /**
     * 获取本地 CSS 片段列表
     */
    async getSnippetsList(): Promise<LocalSnippet[]> {
        try {
            const snippets: LocalSnippet[] = [];
            
            // 检查 snippets 目录是否存在
            const snippetsFolderExists = await this.app.vault.adapter.exists(this.snippetsPath);
            if (!snippetsFolderExists) {
                // 创建 snippets 目录
                await this.app.vault.adapter.mkdir(this.snippetsPath);
                return [];
            }

            // 获取所有 .css 文件
            const files = await this.app.vault.adapter.list(this.snippetsPath);
            
            for (const file of files.files) {
                if (file.endsWith('.css')) {
                    const fileName = file.split('/').pop() || file;
                    const rawContent = await this.app.vault.adapter.read(file);
                    // 标准化内容，确保与云端文件哈希计算一致
                    const content = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
                    const stats = await this.app.vault.adapter.stat(file);
                    
                    snippets.push({
                        name: fileName,
                        path: file,
                        content: rawContent, // 保存原始内容用于其他操作
                        enabled: this.isSnippetEnabled(fileName),
                        lastModified: stats?.mtime || 0,
                        hash: HashUtils.calculateHash(content) // 使用标准化内容计算哈希
                    });
                }
            }

            return snippets;
        } catch (error) {
            console.error('Error getting snippets list:', error);
            throw error;
        }
    }

    /**
     * 读取指定的 CSS 片段
     */
    async readSnippet(filename: string): Promise<string> {
        try {
            const filePath = normalizePath(`${this.snippetsPath}/${filename}`);
            return await this.app.vault.adapter.read(filePath);
        } catch (error) {
            console.error('Error reading snippet:', error);
            throw error;
        }
    }

    /**
     * 写入 CSS 片段
     */
    async writeSnippet(filename: string, content: string): Promise<boolean> {
        try {
            // 确保文件名以 .css 结尾
            if (!filename.endsWith('.css')) {
                filename += '.css';
            }

            // 确保 snippets 目录存在
            await this.ensureSnippetsDirectory();

            const filePath = normalizePath(`${this.snippetsPath}/${filename}`);
            await this.app.vault.adapter.write(filePath, content);
            
            return true;
        } catch (error) {
            console.error('Error writing snippet:', error);
            throw error;
        }
    }

    /**
     * 删除 CSS 片段
     */
    async deleteSnippet(filename: string): Promise<boolean> {
        try {
            const filePath = normalizePath(`${this.snippetsPath}/${filename}`);
            await this.app.vault.adapter.remove(filePath);
            
            // 如果片段当前是启用的，也需要从启用列表中移除
            if (this.isSnippetEnabled(filename)) {
                await this.toggleSnippet(filename);
            }
            
            return true;
        } catch (error) {
            console.error('Error deleting snippet:', error);
            throw error;
        }
    }

    /**
     * 检查 CSS 片段是否启用
     */
    isSnippetEnabled(filename: string): boolean {
        try {
            const snippetName = filename.replace('.css', '');
            
            // 方法1：尝试使用 Obsidian 的内部 API
            try {
                const customCss = (this.app as any).customCss;
                if (customCss && customCss.enabledSnippets) {
                    // 检查是否在启用列表中
                    if (typeof customCss.enabledSnippets.has === 'function') {
                        return customCss.enabledSnippets.has(snippetName);
                    }
                    // 备用检查方式
                    if (Array.isArray(customCss.enabledSnippets)) {
                        return customCss.enabledSnippets.includes(snippetName);
                    }
                }
            } catch (apiError) {
                console.warn('Obsidian internal API failed for snippet status check:', apiError);
            }

            // 方法2：检查 DOM 中是否存在相应的样式标签
            try {
                // 查找带有 data-snippet-id 的 style 标签
                const styleElements = document.querySelectorAll('style[data-snippet-id]');
                for (let i = 0; i < styleElements.length; i++) {
                    const element = styleElements[i];
                    if (element.getAttribute('data-snippet-id') === snippetName) {
                        return true;
                    }
                }

                // 查找包含片段标识符的 style 标签
                const allStyleElements = document.querySelectorAll('style');
                for (let i = 0; i < allStyleElements.length; i++) {
                    const element = allStyleElements[i];
                    if (element.textContent && element.textContent.includes(`/* ${snippetName} */`)) {
                        return true;
                    }
                }
            } catch (domError) {
                console.warn('DOM check failed for snippet status:', domError);
            }

            // 方法3：检查 body 的 CSS 类
            try {
                return document.body.classList.contains(`css-snippet-${snippetName}`);
            } catch (classError) {
                console.warn('CSS class check failed for snippet status:', classError);
            }

            return false;
        } catch (error) {
            console.error('Error checking snippet enabled status:', error);
            return false;
        }
    }

    /**
     * 切换 CSS 片段的启用状态
     */
    async toggleSnippet(filename: string): Promise<boolean> {
        try {
            const snippetName = filename.replace('.css', '');
            const isCurrentlyEnabled = this.isSnippetEnabled(filename);
            
            // 尝试使用 Obsidian 的内部方法来启用/禁用 CSS 片段
            try {
                const customCss = (this.app as any).customCss;
                if (customCss && typeof customCss.setCssEnabledStatus === 'function') {
                    customCss.setCssEnabledStatus(snippetName, !isCurrentlyEnabled);
                    return true;
                }
            } catch (apiError) {
                console.warn('Obsidian internal API method failed, trying alternative approach:', apiError);
            }

            // 备用方案：使用文件重命名方式
            const snippetPath = normalizePath(`${this.snippetsPath}/${filename}`);
            const disabledPath = `${snippetPath}.disabled`;
            
            if (isCurrentlyEnabled) {
                // 禁用：重命名为 .css.disabled
                if (await this.app.vault.adapter.exists(snippetPath)) {
                    const content = await this.app.vault.adapter.read(snippetPath);
                    await this.app.vault.adapter.write(disabledPath, content);
                    await this.app.vault.adapter.remove(snippetPath);
                }
            } else {
                // 启用：从 .css.disabled 重命名为 .css
                if (await this.app.vault.adapter.exists(disabledPath)) {
                    const content = await this.app.vault.adapter.read(disabledPath);
                    await this.app.vault.adapter.write(snippetPath, content);
                    await this.app.vault.adapter.remove(disabledPath);
                } else {
                    // 如果没有禁用文件，检查原文件是否存在
                    const originalPath = normalizePath(`${this.snippetsPath}/${filename}`);
                    if (await this.app.vault.adapter.exists(originalPath)) {
                        // 文件存在但未启用，可能需要刷新
                        const content = await this.app.vault.adapter.read(originalPath);
                        // 添加一个微小的更改来触发 Obsidian 重新加载
                        const updatedContent = content + `\n/* Updated: ${Date.now()} */`;
                        await this.app.vault.adapter.write(originalPath, updatedContent);
                        
                        // 100ms 后移除更改标记
                        setTimeout(async () => {
                            try {
                                await this.app.vault.adapter.write(originalPath, content);
                            } catch (cleanupError) {
                                console.warn('Failed to remove update marker:', cleanupError);
                            }
                        }, 100);
                    }
                }
            }

            return true;
        } catch (error) {
            console.error('Error toggling snippet:', error);
            throw error;
        }
    }

    /**
     * 验证文件路径安全性
     */
    private validatePath(path: string): boolean {
        // 防止路径遍历攻击
        if (path.includes('..') || path.includes('~') || path.includes('\\..\\') || path.includes('/..')) {
            return false;
        }
        
        // 检查是否包含危险字符
        const dangerousChars = ['<', '>', ':', '"', '|', '?', '*'];
        if (dangerousChars.some(char => path.includes(char))) {
            return false;
        }
        
        // 确保路径在snippets目录内
        const normalizedPath = normalizePath(path);
        const snippetsNormalized = normalizePath(this.snippetsPath);
        if (!normalizedPath.startsWith(snippetsNormalized)) {
            return false;
        }
        
        return true;
    }

    /**
     * 在系统默认编辑器中打开 CSS 片段
     */
    async openInEditor(filename: string, editorPath?: string): Promise<boolean> {
        try {
            const filePath = normalizePath(`${this.snippetsPath}/${filename}`);
            
            // 验证完整文件路径的安全性
            if (!this.validatePath(filePath)) {
                throw new Error('不安全的文件路径');
            }
            
            const fullPath = `${(this.app.vault.adapter as any).basePath || ''}/${filePath}`;
            
            // 使用 Electron 的 shell API 安全地打开文件
            const { shell } = require('electron');
            if (shell && shell.openPath) {
                await shell.openPath(fullPath);
                return true;
            } else {
                // 降级方案：使用 Obsidian 的原生文件操作
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    // 在 Obsidian 中打开文件
                    const leaf = this.app.workspace.getUnpinnedLeaf();
                    await leaf.openFile(file);
                    return true;
                } else {
                    throw new Error('文件不存在或无法访问');
                }
            }
        } catch (error) {
            console.error('Error opening snippet in editor:', error);
            // 提供更安全的错误处理
            throw new Error(`无法打开文件: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 重命名 CSS 片段
     */
    async renameSnippet(oldFilename: string, newFilename: string): Promise<boolean> {
        try {
            // 确保新文件名以 .css 结尾
            if (!newFilename.endsWith('.css')) {
                newFilename += '.css';
            }

            const oldPath = normalizePath(`${this.snippetsPath}/${oldFilename}`);
            const newPath = normalizePath(`${this.snippetsPath}/${newFilename}`);
            
            // 读取原文件内容
            const content = await this.app.vault.adapter.read(oldPath);
            
            // 写入新文件
            await this.app.vault.adapter.write(newPath, content);
            
            // 删除原文件
            await this.app.vault.adapter.remove(oldPath);
            
            // 如果原文件是启用的，需要更新启用状态
            if (this.isSnippetEnabled(oldFilename)) {
                await this.toggleSnippet(oldFilename); // 禁用原文件
                await this.toggleSnippet(newFilename); // 启用新文件
            }
            
            return true;
        } catch (error) {
            console.error('Error renaming snippet:', error);
            throw error;
        }
    }

    /**
     * 获取 snippets 目录路径
     */
    getSnippetsPath(): string {
        return this.snippetsPath;
    }

    /**
     * 在系统文件管理器中打开snippets文件夹
     */
    async openFolderInExplorer(folderPath?: string): Promise<boolean> {
        try {
            const targetPath = folderPath || this.snippetsPath;
            const basePath = (this.app.vault.adapter as any).basePath || '';
            
            // 使用path.join正确处理路径分隔符，然后根据平台规范化
            let fullPath = path.join(basePath, targetPath);
            fullPath = path.resolve(fullPath);
            
            // 验证路径安全性
            if (!this.validatePath(fullPath)) {
                throw new Error('不安全的文件路径');
            }
            
            // 首先尝试使用 Electron 的 shell API（最安全）
            try {
                const { shell } = require('electron');
                if (shell && shell.openPath) {
                    await shell.openPath(fullPath);
                    return true;
                }
            } catch (error) {
                console.warn('Electron shell API不可用，使用降级方案');
            }
            
            const platform = process.platform;
            
            // 使用spawn来执行命令（避免shell注入）
            return new Promise((resolve, reject) => {
                const { spawn } = require('child_process');
                let child: any;
                
                // 移除危险字符，确保路径安全
                const safePath = fullPath.replace(/["'`\\$]/g, '');
                
                try {
                    // 使用系统默认文件管理器，不使用shell
                    switch (platform) {
                        case 'win32':
                            fullPath = fullPath.replace(/\//g, '\\');
                            child = spawn('explorer', [fullPath], { 
                                detached: true,
                                stdio: 'ignore',
                                shell: false // 禁用shell防止命令注入
                            });
                            break;
                        case 'darwin':
                            child = spawn('open', [fullPath], { 
                                detached: true,
                                stdio: 'ignore',
                                shell: false
                            });
                            break;
                        case 'linux':
                            child = spawn('xdg-open', [fullPath], { 
                                detached: true,
                                stdio: 'ignore',
                                shell: false
                            });
                            break;
                        default:
                            throw new Error(`不支持的操作系统: ${platform}`);
                    }
                    
                    if (child) {
                        child.unref(); // 允许父进程退出而不等待子进程
                        
                        // 设置超时防止进程挂起
                        const timeout = setTimeout(() => {
                            if (child && !child.killed) {
                                child.kill();
                                reject(new Error('打开文件夹超时'));
                            }
                        }, 5000);
                        
                        child.on('error', (error: Error) => {
                            clearTimeout(timeout);
                            console.error('Spawn error:', error);
                            reject(error);
                        });
                        
                        child.on('exit', (code: number | null) => {
                            clearTimeout(timeout);
                            if (code === 0 || code === null) {
                                resolve(true);
                            } else {
                                reject(new Error(`文件管理器退出，代码: ${code}`));
                            }
                        });
                        
                        // 给子进程一些时间启动
                        setTimeout(() => {
                            clearTimeout(timeout);
                            resolve(true);
                        }, 500);
                    } else {
                        reject(new Error('无法启动文件管理器'));
                    }
                } catch (spawnError) {
                    console.error('Spawn error:', spawnError);
                    reject(spawnError);
                }
            });
            
        } catch (error) {
            console.error('Error opening folder in explorer:', error);
            throw error;
        }
    }

    /**
     * 确保 snippets 目录存在
     */
    async ensureSnippetsDirectory(): Promise<void> {
        try {
            const exists = await this.app.vault.adapter.exists(this.snippetsPath);
            if (!exists) {
                await this.app.vault.adapter.mkdir(this.snippetsPath);
            }
        } catch (error) {
            console.error('Error ensuring snippets directory:', error);
            throw error;
        }
    }

    /**
     * 验证 CSS 内容
     */
    validateCssContent(content: string): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];
        
        // 基础的 CSS 语法检查
        if (!content.trim()) {
            errors.push('CSS 内容不能为空');
            return { isValid: false, errors };
        }

        // 检查基本的花括号匹配
        const openBraces = (content.match(/{/g) || []).length;
        const closeBraces = (content.match(/}/g) || []).length;
        
        if (openBraces !== closeBraces) {
            errors.push('花括号不匹配');
        }

        // 可以添加更多的 CSS 验证规则
        
        return {
            isValid: errors.length === 0,
            errors
        };
    }
}
