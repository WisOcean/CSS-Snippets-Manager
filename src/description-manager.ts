import { CSSSnippetsManagerSettings } from '../main';

export class DescriptionManager {
    private settings: CSSSnippetsManagerSettings;
    private saveCallback: () => Promise<void>;

    constructor(settings: CSSSnippetsManagerSettings, saveCallback: () => Promise<void>) {
        this.settings = settings;
        this.saveCallback = saveCallback;
    }

    /**
     * 获取 CSS 片段的描述
     */
    getDescription(filename: string): string {
        const snippetName = this.normalizeFilename(filename);
        return this.settings.snippetDescriptions[snippetName] || '';
    }

    /**
     * 设置 CSS 片段的描述
     */
    async setDescription(filename: string, description: string): Promise<void> {
        const snippetName = this.normalizeFilename(filename);
        
        if (description.trim()) {
            this.settings.snippetDescriptions[snippetName] = description.trim();
        } else {
            delete this.settings.snippetDescriptions[snippetName];
        }
        
        await this.saveCallback();
    }

    /**
     * 删除 CSS 片段的描述
     */
    async removeDescription(filename: string): Promise<void> {
        const snippetName = this.normalizeFilename(filename);
        delete this.settings.snippetDescriptions[snippetName];
        await this.saveCallback();
    }

    /**
     * 获取所有有描述的片段
     */
    getAllDescriptions(): Record<string, string> {
        return { ...this.settings.snippetDescriptions };
    }

    /**
     * 搜索描述中包含指定关键词的片段
     */
    searchByDescription(query: string): string[] {
        const lowerQuery = query.toLowerCase();
        const results: string[] = [];
        
        for (const [filename, description] of Object.entries(this.settings.snippetDescriptions)) {
            if (typeof description === 'string' && description.toLowerCase().includes(lowerQuery)) {
                results.push(filename);
            }
        }
        
        return results;
    }

    /**
     * 标准化文件名（移除 .css 扩展名）
     */
    private normalizeFilename(filename: string): string {
        return filename.endsWith('.css') ? filename.slice(0, -4) : filename;
    }

    /**
     * 清理不存在的文件的描述
     */
    async cleanupDescriptions(existingFiles: string[]): Promise<void> {
        const normalizedFiles = existingFiles.map(f => this.normalizeFilename(f));
        const descriptionsToRemove: string[] = [];
        
        for (const filename of Object.keys(this.settings.snippetDescriptions)) {
            if (!normalizedFiles.includes(filename)) {
                descriptionsToRemove.push(filename);
            }
        }
        
        for (const filename of descriptionsToRemove) {
            delete this.settings.snippetDescriptions[filename];
        }
        
        if (descriptionsToRemove.length > 0) {
            await this.saveCallback();
        }
    }

}
