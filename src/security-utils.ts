/**
 * 安全工具类 - 处理敏感数据的加密存储和安全操作
 */
export class SecurityUtils {
    private static readonly ENCRYPTION_KEY = 'css-snippets-manager-key';
    
    /**
     * 过滤错误信息中的敏感数据
     */
    static sanitizeErrorMessage(error: Error | string): string {
        const message = error instanceof Error ? error.message : error;
        
        // 移除可能的敏感路径信息
        let sanitized = message.replace(/[C-Z]:\\[^\\s]*/g, '[PATH]'); // Windows路径
        sanitized = sanitized.replace(/\/[^\/\s]*\/[^\/\s]*/g, '[PATH]'); // Unix路径
        sanitized = sanitized.replace(/~\/[^\/\s]*/g, '[PATH]'); // 用户目录
        
        // 移除可能的token信息
        sanitized = sanitized.replace(/ghp_[a-zA-Z0-9]{36}/g, '[TOKEN]'); // GitHub personal access token
        sanitized = sanitized.replace(/ghs_[a-zA-Z0-9]{36}/g, '[TOKEN]'); // GitHub server token
        sanitized = sanitized.replace(/token[:\s=][a-zA-Z0-9_-]+/gi, 'token=[TOKEN]');
        
        // 移除API密钥等
        sanitized = sanitized.replace(/[a-f0-9]{32,}/gi, '[KEY]'); // 通用密钥格式
        
        return sanitized;
    }
    
    /**
     * 安全地记录错误
     */
    static logError(error: Error | string, context?: string): void {
        const sanitizedMessage = this.sanitizeErrorMessage(error);
        const logMessage = context ? `${context}: ${sanitizedMessage}` : sanitizedMessage;
        console.error('CSS Snippets Manager Error:', logMessage);
    }
    
    /**
     * 简单的字符串加密（Base64 + 混淆）
     * 注意：这不是强加密，主要用于避免明文存储
     * 对于更高安全性要求，建议使用系统密钥库
     */
    static encryptToken(token: string): string {
        if (!token) return '';
        
        try {
            // 增强的混淆算法 - 添加更多变化
            const scrambled = token.split('').map((char, index) => {
                const shift = (index % 5) + 1; // 更大的变化范围
                const scrambledChar = char.charCodeAt(0) + shift;
                return String.fromCharCode(scrambledChar);
            }).join('');
            
            // 添加简单的异或操作增强安全性
            const xorKey = 42; // 简单的XOR密钥
            const xorScrambled = scrambled.split('').map(char => 
                String.fromCharCode(char.charCodeAt(0) ^ xorKey)
            ).join('');
            
            // Base64编码
            return btoa(xorScrambled);
        } catch (error) {
            console.error('Token encryption failed:', error);
            return token; // 如果加密失败，返回原始token
        }
    }
    
    /**
     * 解密Token
     */
    static decryptToken(encryptedToken: string): string {
        if (!encryptedToken) return '';
        
        try {
            // Base64解码
            const xorScrambled = atob(encryptedToken);
            
            // 反向异或操作
            const xorKey = 42;
            const scrambled = xorScrambled.split('').map(char => 
                String.fromCharCode(char.charCodeAt(0) ^ xorKey)
            ).join('');
            
            // 反混淆
            const original = scrambled.split('').map((char, index) => {
                const shift = (index % 5) + 1;
                const originalChar = char.charCodeAt(0) - shift;
                return String.fromCharCode(originalChar);
            }).join('');
            
            return original;
        } catch (error) {
            console.error('Token decryption failed:', error);
            return encryptedToken; // 如果解密失败，返回原始值
        }
    }
    
    /**
     * 验证GitHub Token格式
     */
    static validateGitHubToken(token: string): { valid: boolean; message: string } {
        if (!token) {
            return { valid: false, message: 'Token不能为空' };
        }
        
        // GitHub Personal Access Token格式验证
        // 经典Token: ghp_xxxx (40个字符)
        // Fine-grained Token: github_pat_xxxx
        const classicTokenPattern = /^ghp_[a-zA-Z0-9]{36}$/;
        const fineGrainedTokenPattern = /^github_pat_[a-zA-Z0-9_]{82}$/;
        
        if (classicTokenPattern.test(token) || fineGrainedTokenPattern.test(token)) {
            return { valid: true, message: 'Token格式正确' };
        }
        
        return { 
            valid: false, 
            message: 'Token格式不正确，请确保是有效的GitHub Personal Access Token' 
        };
    }
    
    /**
     * 验证GitHub仓库URL格式
     */
    static validateGitHubRepoUrl(url: string): { valid: boolean; message: string; owner?: string; repo?: string } {
        if (!url) {
            return { valid: false, message: '仓库URL不能为空' };
        }
        
        // 支持的URL格式：
        // https://github.com/owner/repo
        // https://github.com/owner/repo.git
        // owner/repo
        const patterns = [
            /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\.git)?$/,
            /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/
        ];
        
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                const [, owner, repo] = match;
                return {
                    valid: true,
                    message: '仓库URL格式正确',
                    owner,
                    repo: repo.replace('.git', '')
                };
            }
        }
        
        return {
            valid: false,
            message: '仓库URL格式不正确，支持格式：https://github.com/owner/repo 或 owner/repo'
        };
    }
    
    /**
     * 安全地处理文件路径，防止路径遍历攻击
     */
    static sanitizeFilePath(filePath: string): string {
        if (!filePath) return '';
        
        // 移除危险字符和路径遍历
        return filePath
            .replace(/\.\./g, '') // 移除 ..
            .replace(/[<>:"|?*]/g, '') // 移除Windows不允许的字符
            .replace(/^\/+|\/+$/g, '') // 移除开头和结尾的斜杠
            .replace(/\/+/g, '/'); // 合并多个斜杠
    }
    
    /**
     * 验证CSS文件名
     */
    static validateCSSFileName(fileName: string): { valid: boolean; message: string } {
        if (!fileName) {
            return { valid: false, message: '文件名不能为空' };
        }
        
        // 检查文件扩展名
        if (!fileName.endsWith('.css')) {
            return { valid: false, message: '文件必须以.css结尾' };
        }
        
        // 检查文件名字符
        const invalidChars = /[<>:"|?*\\\/]/;
        if (invalidChars.test(fileName)) {
            return { valid: false, message: '文件名包含无效字符' };
        }
        
        // 检查长度
        if (fileName.length > 255) {
            return { valid: false, message: '文件名过长' };
        }
        
        return { valid: true, message: '文件名有效' };
    }
    
    /**
     * 清理HTML内容，防止XSS
     */
    static sanitizeHTML(html: string): string {
        if (!html) return '';
        
        // 简单的HTML清理，移除脚本和危险标签
        return html
            .replace(/<script[^>]*>.*?<\/script>/gi, '')
            .replace(/<iframe[^>]*>.*?<\/iframe>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, ''); // 移除事件处理器
    }
    
    /**
     * 生成安全的随机ID
     */
    static generateSecureId(): string {
        const timestamp = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substr(2, 9);
        return `${timestamp}-${randomPart}`;
    }
}
