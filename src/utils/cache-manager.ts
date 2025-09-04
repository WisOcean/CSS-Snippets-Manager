/**
 * 缓存管理器 - 提供统一的缓存功能
 */
export interface CacheItem<T> {
    data: T;
    timestamp: number;
    size?: number;
}

export interface CacheOptions {
    expiryMs?: number;
    maxSize?: number;
    maxItems?: number;
}

export class CacheManager {
    private static instance: CacheManager;
    private caches: Map<string, Map<string, CacheItem<any>>> = new Map();
    private defaultOptions: CacheOptions = {
        expiryMs: 5 * 60 * 1000, // 5分钟
        maxSize: 50 * 1024 * 1024, // 50MB
        maxItems: 1000
    };

    private constructor() {}

    public static getInstance(): CacheManager {
        if (!CacheManager.instance) {
            CacheManager.instance = new CacheManager();
        }
        return CacheManager.instance;
    }

    /**
     * 创建或获取缓存
     */
    getCache<T>(cacheId: string): Map<string, CacheItem<T>> {
        if (!this.caches.has(cacheId)) {
            this.caches.set(cacheId, new Map());
        }
        return this.caches.get(cacheId)!;
    }

    /**
     * 设置缓存项
     */
    set<T>(cacheId: string, key: string, data: T, options?: CacheOptions): void {
        const cache = this.getCache<T>(cacheId);
        const opts = { ...this.defaultOptions, ...options };
        
        // 清理过期项
        this.cleanupExpired(cacheId, opts.expiryMs!);
        
        // 检查大小限制
        if (cache.size >= opts.maxItems!) {
            this.evictOldest(cacheId);
        }
        
        cache.set(key, {
            data,
            timestamp: Date.now(),
            size: this.calculateSize(data)
        });
    }

    /**
     * 获取缓存项
     */
    get<T>(cacheId: string, key: string, options?: CacheOptions): T | null {
        const cache = this.getCache<T>(cacheId);
        const item = cache.get(key);
        
        if (!item) {
            return null;
        }
        
        const opts = { ...this.defaultOptions, ...options };
        const isExpired = Date.now() - item.timestamp > opts.expiryMs!;
        
        if (isExpired) {
            cache.delete(key);
            return null;
        }
        
        return item.data;
    }

    /**
     * 检查缓存是否存在且有效
     */
    has(cacheId: string, key: string, options?: CacheOptions): boolean {
        return this.get(cacheId, key, options) !== null;
    }

    /**
     * 删除缓存项
     */
    delete(cacheId: string, key: string): boolean {
        const cache = this.getCache(cacheId);
        return cache.delete(key);
    }

    /**
     * 清空指定缓存
     */
    clear(cacheId: string): void {
        const cache = this.getCache(cacheId);
        cache.clear();
    }

    /**
     * 清空所有缓存
     */
    clearAll(): void {
        this.caches.clear();
    }

    /**
     * 清理过期项
     */
    private cleanupExpired(cacheId: string, expiryMs: number): void {
        const cache = this.getCache(cacheId);
        const now = Date.now();
        
        for (const [key, item] of cache.entries()) {
            if (now - item.timestamp > expiryMs) {
                cache.delete(key);
            }
        }
    }

    /**
     * 清理最旧的项
     */
    private evictOldest(cacheId: string): void {
        const cache = this.getCache(cacheId);
        let oldestKey: string | null = null;
        let oldestTime = Date.now();
        
        for (const [key, item] of cache.entries()) {
            if (item.timestamp < oldestTime) {
                oldestTime = item.timestamp;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            cache.delete(oldestKey);
        }
    }

    /**
     * 计算数据大小（简单估算）
     */
    private calculateSize(data: any): number {
        try {
            return JSON.stringify(data).length * 2; // 简单估算，Unicode字符占2字节
        } catch {
            return 0;
        }
    }

    /**
     * 获取缓存统计信息
     */
    getStats(cacheId?: string): Record<string, any> {
        if (cacheId) {
            const cache = this.getCache(cacheId);
            let totalSize = 0;
            let validItems = 0;
            
            for (const item of cache.values()) {
                totalSize += item.size || 0;
                validItems++;
            }
            
            return {
                items: validItems,
                totalSize,
                avgItemSize: validItems > 0 ? totalSize / validItems : 0
            };
        }
        
        const stats: Record<string, any> = {};
        for (const [id] of this.caches.entries()) {
            stats[id] = this.getStats(id);
        }
        return stats;
    }
}
