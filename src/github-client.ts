import { Notice } from 'obsidian';

import { SecurityUtils } from './security-utils';

export interface GitHubFile {
    name: string;
    path: string;
    sha: string;
    size: number;
    url: string;
    content?: string;
    lastModified?: string;
}

export interface GitHubApiResponse {
    success: boolean;
    data?: any;
    error?: string;
}

export class GitHubClient {
    private token: string;
    private repoUrl: string;
    private baseApiUrl = 'https://api.github.com';

    constructor(token: string, repoUrl: string) {
        this.token = token;
        this.repoUrl = repoUrl;
    }

    /**
     * 验证 GitHub 连接
     */
    async authenticate(): Promise<boolean> {
        try {
            const response = await this.makeRequest('/user');
            return response.success;
        } catch (error) {
            SecurityUtils.logError(error, 'GitHub authentication failed');
            return false;
        }
    }

    /**
     * 获取仓库中的 .css 文件列表
     */
    async listFiles(path: string = ''): Promise<GitHubFile[]> {
        try {
            const url = `/repos/${this.repoUrl}/contents/${path}`;
            const response = await this.makeRequest(url);
            
            if (!response.success) {
                throw new Error(response.error || 'Failed to fetch files');
            }

            const files: GitHubFile[] = [];
            const items = Array.isArray(response.data) ? response.data : [response.data];

            for (const item of items) {
                if (item.type === 'file' && item.name.endsWith('.css')) {
                    // 获取文件的最后修改时间
                    const lastModified = await this.getFileLastModified(item.path);
                    
                    files.push({
                        name: item.name,
                        path: item.path,
                        sha: item.sha,
                        size: item.size,
                        url: item.download_url,
                        lastModified
                    });
                } else if (item.type === 'dir') {
                    // 递归获取子目录中的 CSS 文件
                    const subFiles = await this.listFiles(item.path);
                    files.push(...subFiles);
                }
            }

            return files;
        } catch (error) {
            console.error('Error listing files:', error);
            throw error;
        }
    }

    /**
     * 下载文件内容
     */
    async downloadFile(path: string): Promise<string> {
        try {
            const url = `/repos/${this.repoUrl}/contents/${path}`;
            const response = await this.makeRequest(url);
            
            if (!response.success) {
                throw new Error(response.error || 'Failed to download file');
            }

            // 文件大小限制 (10MB)
            const MAX_FILE_SIZE = 10 * 1024 * 1024;

            if (response.data.content) {
                // Base64 解码，与上传时的编码方式对应
                const base64Content = response.data.content.replace(/\s/g, '');
                const content = decodeURIComponent(escape(atob(base64Content)));
                if (content.length > MAX_FILE_SIZE) {
                    throw new Error(`文件过大 (${Math.round(content.length / 1024 / 1024)}MB)，最大允许10MB`);
                }
                return content;
            } else if (response.data.download_url) {
                // 直接下载
                const downloadResponse = await fetch(response.data.download_url);
                
                // 检查Content-Length头
                const contentLength = downloadResponse.headers.get('Content-Length');
                if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
                    throw new Error(`文件过大 (${Math.round(parseInt(contentLength) / 1024 / 1024)}MB)，最大允许10MB`);
                }
                
                const content = await downloadResponse.text();
                if (content.length > MAX_FILE_SIZE) {
                    throw new Error(`文件过大 (${Math.round(content.length / 1024 / 1024)}MB)，最大允许10MB`);
                }
                return content;
            }

            throw new Error('No content available');
        } catch (error) {
            console.error('Error downloading file:', error);
            throw error;
        }
    }

    /**
     * 上传或更新文件
     */
    async uploadFile(path: string, content: string, message?: string): Promise<boolean> {
        try {
            // 首先检查文件是否存在
            const existingFile = await this.getFileInfo(path);
            
            const url = `/repos/${this.repoUrl}/contents/${path}`;
            
            // 使用与下载时相对应的编码方式
            // 确保上传和下载的编码解码一致性
            const base64Content = btoa(unescape(encodeURIComponent(content)));
            
            const body: any = {
                message: message || `Update ${path}`,
                content: base64Content
            };

            if (existingFile) {
                body.sha = existingFile.sha;
            }

            const response = await this.makeRequest(url, 'PUT', body);
            return response.success;
        } catch (error) {
            console.error('Error uploading file:', error);
            throw error;
        }
    }

    /**
     * 删除文件
     */
    async deleteFile(path: string, message?: string): Promise<boolean> {
        try {
            const fileInfo = await this.getFileInfo(path);
            if (!fileInfo) {
                throw new Error('File not found');
            }

            const url = `/repos/${this.repoUrl}/contents/${path}`;
            const body = {
                message: message || `Delete ${path}`,
                sha: fileInfo.sha
            };

            const response = await this.makeRequest(url, 'DELETE', body);
            return response.success;
        } catch (error) {
            console.error('Error deleting file:', error);
            throw error;
        }
    }

    /**
     * 获取文件信息
     */
    private async getFileInfo(path: string): Promise<GitHubFile | null> {
        try {
            const url = `/repos/${this.repoUrl}/contents/${path}`;
            const response = await this.makeRequest(url);
            
            if (response.success) {
                return {
                    name: response.data.name,
                    path: response.data.path,
                    sha: response.data.sha,
                    size: response.data.size,
                    url: response.data.download_url
                };
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 获取文件的最后修改时间
     */
    private async getFileLastModified(path: string): Promise<string> {
        try {
            const url = `/repos/${this.repoUrl}/commits?path=${encodeURIComponent(path)}&per_page=1`;
            const response = await this.makeRequest(url);
            
            if (response.success && response.data && response.data.length > 0) {
                return response.data[0].commit.committer.date;
            }
            return 'Unknown';
        } catch (error) {
            console.warn('Failed to get file last modified time:', error);
            return 'Unknown';
        }
    }

    /**
     * 发送 API 请求
     */
    private async makeRequest(endpoint: string, method: string = 'GET', body?: any): Promise<GitHubApiResponse> {
        try {
            const headers: HeadersInit = {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'CSS-Snippets-Manager'
            };

            if (body && (method === 'POST' || method === 'PUT')) {
                headers['Content-Type'] = 'application/json';
            }

            // 添加超时控制
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时

            const config: RequestInit = {
                method,
                headers,
                signal: controller.signal
            };

            if (body) {
                config.body = JSON.stringify(body);
            }

            try {
                console.log(`🌐 发送请求: ${method} ${this.baseApiUrl}${endpoint}`);
                const response = await fetch(`${this.baseApiUrl}${endpoint}`, config);
                clearTimeout(timeoutId); // 清除超时定时器
                
                console.log(`📡 响应状态: ${response.status} ${response.statusText}`);
                
                // 处理不同的HTTP状态码
                if (response.status === 401) {
                    return {
                        success: false,
                        error: 'Token认证失败，请检查Token是否正确和有效'
                    };
                }
                
                if (response.status === 403) {
                    return {
                        success: false,
                        error: 'API访问被禁止，可能是Token权限不足或访问频率超限'
                    };
                }
                
                if (response.status === 404) {
                    return {
                        success: false,
                        error: '仓库不存在或无访问权限，请检查仓库URL和Token权限'
                    };
                }
                
                const data = await response.json();

                if (!response.ok) {
                    const errorMessage = data.message || `HTTP ${response.status}: ${response.statusText}`;
                    return {
                        success: false,
                        error: errorMessage
                    };
                }

                return {
                    success: true,
                    data
                };
            } catch (fetchError) {
                clearTimeout(timeoutId); // 确保清除超时定时器
                
                if (fetchError instanceof Error) {
                    console.error('🚫 请求异常:', fetchError.message);
                    
                    if (fetchError.name === 'AbortError') {
                        return {
                            success: false,
                            error: '请求超时，请检查网络连接稳定性'
                        };
                    }
                    
                    if (fetchError.message.includes('Failed to fetch')) {
                        return {
                            success: false,
                            error: '网络连接失败，请检查网络连接和防火墙设置'
                        };
                    }
                }
                
                throw fetchError;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error('💥 makeRequest错误:', errorMessage);
            return {
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * 更新 token 和仓库 URL
     */
    updateCredentials(token: string, repoUrl: string) {
        this.token = token;
        this.repoUrl = repoUrl;
    }
}
