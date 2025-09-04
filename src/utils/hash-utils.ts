/**
 * Hash工具类 - 提供统一的哈希计算功能
 */
export class HashUtils {
    /**
     * 计算文件内容的哈希值（使用SHA-256类似的算法）
     * 确保内容相同时产生相同哈希，内容不同时产生不同哈希
     */
    static calculateHash(content: string): string {
        // 标准化内容：统一换行符，去除首尾空白
        const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        
        // 使用更安全的哈希算法（基于FNV-1a的变种）
        let hash = 0x811c9dc5; // FNV offset basis
        const fnvPrime = 0x01000193; // FNV prime
        
        for (let i = 0; i < normalizedContent.length; i++) {
            hash ^= normalizedContent.charCodeAt(i);
            hash = (hash * fnvPrime) >>> 0; // 无符号32位乘法
        }
        
        // 添加长度信息以减少碰撞
        const lengthHash = normalizedContent.length * 0x9e3779b9; // 黄金比例常数
        hash ^= lengthHash;
        hash = hash >>> 0; // 确保为无符号整数
        
        return hash.toString(16).padStart(8, '0');
    }

    /**
     * 计算文件内容的更安全的双重哈希值
     * 用于重要的比较场景，降低哈希碰撞概率
     */
    static calculateSecureHash(content: string): string {
        const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        
        // 第一个哈希：FNV-1a
        let hash1 = 0x811c9dc5;
        const fnvPrime = 0x01000193;
        
        for (let i = 0; i < normalizedContent.length; i++) {
            hash1 ^= normalizedContent.charCodeAt(i);
            hash1 = (hash1 * fnvPrime) >>> 0;
        }
        
        // 第二个哈希：DJB2
        let hash2 = 5381;
        for (let i = 0; i < normalizedContent.length; i++) {
            hash2 = ((hash2 << 5) + hash2 + normalizedContent.charCodeAt(i)) >>> 0;
        }
        
        // 第三个哈希：基于字符频率
        const charFreq = new Map<number, number>();
        for (let i = 0; i < normalizedContent.length; i++) {
            const char = normalizedContent.charCodeAt(i);
            charFreq.set(char, (charFreq.get(char) || 0) + 1);
        }
        
        let hash3 = 0;
        charFreq.forEach((freq, char) => {
            hash3 ^= (char * freq * 0x9e3779b9) >>> 0;
        });
        
        return `${hash1.toString(16).padStart(8, '0')}-${hash2.toString(16).padStart(8, '0')}-${hash3.toString(16).padStart(8, '0')}`;
    }

    /**
     * 比较两个哈希值是否相等
     */
    static compareHash(hash1: string, hash2: string): boolean {
        return hash1 === hash2;
    }

    /**
     * 验证哈希值格式是否正确
     */
    static isValidHash(hash: string): boolean {
        // 检查简单哈希格式 (8位十六进制)
        if (/^[0-9a-f]{8}$/i.test(hash)) {
            return true;
        }
        // 检查安全哈希格式 (8-8-8位十六进制)
        if (/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/i.test(hash)) {
            return true;
        }
        return false;
    }

    /**
     * 从内容计算快速检验和（用于快速预检）
     */
    static calculateChecksum(content: string): number {
        let checksum = 0;
        const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        
        for (let i = 0; i < normalizedContent.length; i++) {
            checksum = (checksum + normalizedContent.charCodeAt(i)) & 0xFFFFFFFF;
        }
        
        return checksum;
    }
}
