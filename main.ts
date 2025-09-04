import { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, setIcon } from 'obsidian';
import { GitHubClient, GitHubFile } from './src/github-client';
import { LocalSnippetsManager, LocalSnippet } from './src/local-snippets-manager';
import { SyncManager } from './src/sync-manager';
import { DescriptionManager } from './src/description-manager';
import { SecurityUtils } from './src/security-utils';
import { HashUtils } from './src/utils/hash-utils';

// CSS Snippets Manager Plugin Settings Interface
export interface CSSSnippetsManagerSettings {
	githubRepoUrl: string;
	githubToken: string;
	githubTokenEncrypted?: string; // 加密存储的Token
	autoEnableNewSnippets: boolean;
	autoOpenAfterSave: boolean;
	lastSyncTime: number;
	snippetDescriptions: Record<string, string>;
	autoSyncInterval: number; // 自动同步间隔（分钟）
	enableAutoSync: boolean; // 是否启用自动同步
	enableTokenEncryption: boolean; // 是否启用Token加密
	iconPosition: 'ribbon' | 'statusbar'; // 图标位置：左侧菜单栏或状态栏
	repoInfo: {
		name: string;
		lastSync: number;
		totalFiles: number;
	} | null;
}

const DEFAULT_SETTINGS: CSSSnippetsManagerSettings = {
	githubRepoUrl: '',
	githubToken: '',
	autoEnableNewSnippets: false,
	autoOpenAfterSave: false,
	lastSyncTime: 0,
	snippetDescriptions: {},
	autoSyncInterval: 30, // 默认30分钟
	enableAutoSync: false,
	enableTokenEncryption: true, // 默认启用加密
	iconPosition: 'ribbon', // 默认在左侧菜单栏显示图标
	repoInfo: null
}

export const VIEW_TYPE_CSS_SNIPPETS_MANAGER = "css-snippets-manager-view";

export default class CSSSnippetsManagerPlugin extends Plugin {
	settings: CSSSnippetsManagerSettings;
	githubClient: GitHubClient;
	localManager: LocalSnippetsManager;
	syncManager: SyncManager;
	descriptionManager: DescriptionManager;
	
	private autoSyncTimer: NodeJS.Timeout | null = null;
	public cloudSearchTimeout: NodeJS.Timeout | null = null;
	public localSearchTimeout: NodeJS.Timeout | null = null;
	private syncInProgress: boolean = false;
	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	
	// Performance monitoring (simplified)
	private performanceLog: { operation: string, duration: number, timestamp: number }[] = [];
	private readonly MAX_PERFORMANCE_LOG_SIZE = 50;
	
	// Simple cache for performance
	private localSnippetsCache: { snippets: LocalSnippet[], timestamp: number } | null = null;
	private readonly CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
	
	// 自动同步时间戳管理
	public lastCloudSync: number = 0;
	
	// 渲染状态管理，防止重复渲染
	private isRenderingLocal: boolean = false;
	private isRenderingCloud: boolean = false;

	/**
	 * 将GitHub URL转换为owner/repo格式
	 */
	private convertGitHubUrl(url: string): string {
		if (!url) return '';
		
		const validation = SecurityUtils.validateGitHubRepoUrl(url);
		if (validation.valid && validation.owner && validation.repo) {
			return `${validation.owner}/${validation.repo}`;
		}
		
		// 如果已经是owner/repo格式，直接返回
		return url;
	}

	async onload() {
		await this.loadSettings();

		// Initialize core managers
		this.localManager = new LocalSnippetsManager(this.app, this.settings);
		const repoPath = this.convertGitHubUrl(this.settings.githubRepoUrl);
		this.githubClient = new GitHubClient(this.settings.githubToken, repoPath);
		this.syncManager = new SyncManager(this.githubClient, this.localManager);
		this.descriptionManager = new DescriptionManager(this.settings, () => this.saveSettings());

		// Register the view
		this.registerView(
			VIEW_TYPE_CSS_SNIPPETS_MANAGER,
			(leaf) => new CSSSnippetsManagerView(leaf, this)
		);

		// Setup icon based on user preference
		this.setupIcon();

		// Add command to open the manager
		this.addCommand({
			id: 'open-css-snippets-manager',
			name: 'Open CSS Snippets Manager',
			callback: async () => {
				await this.activateView();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new CSSSnippetsManagerSettingTab(this.app, this));

		// Start auto sync if enabled
		if (this.settings.enableAutoSync) {
			this.startAutoSync();
		}

		console.log('[CSS Snippets Manager] Plugin loaded successfully');
	}

	// 根据设置配置图标位置
	setupIcon() {
		// 先清除已有的图标
		this.removeAllIcons();
		
		if (this.settings.iconPosition === 'ribbon') {
			this.createRibbonIcon();
		} else {
			this.createStatusBarIcon();
		}
	}

	// 添加左侧菜单栏图标
	createRibbonIcon() {
		if (!this.ribbonIconEl) {
			this.ribbonIconEl = this.addRibbonIcon('code', 'CSS Snippets Manager', async (evt: MouseEvent) => {
				await this.activateView();
			});
			this.ribbonIconEl.addClass('css-snippets-manager-ribbon-class');
		}
	}

	// 添加状态栏图标
	createStatusBarIcon() {
		if (!this.statusBarItem) {
			this.statusBarItem = this.addStatusBarItem();
			this.statusBarItem.createEl('span', {
				cls: 'status-bar-item-icon',
				attr: {
					'data-icon': 'code'
				}
			});
			this.statusBarItem.addClass('css-snippets-manager-status-bar');
			this.statusBarItem.onClickEvent(async () => {
				await this.activateView();
			});
			this.statusBarItem.setAttribute('aria-label', 'CSS Snippets Manager');
			
			// 使用Obsidian的setIcon函数设置图标
			const iconEl = this.statusBarItem.querySelector('.status-bar-item-icon');
			if (iconEl) {
				setIcon(iconEl as HTMLElement, 'code');
			}
		}
	}

	// 移除所有图标
	removeAllIcons() {
		if (this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}
		if (this.statusBarItem) {
			this.statusBarItem.remove();
			this.statusBarItem = null;
		}
	}

	// 切换图标位置
	switchIconPosition(position: 'ribbon' | 'statusbar') {
		this.settings.iconPosition = position;
		this.setupIcon();
		this.saveSettings();
	}

	// 移除状态栏图标
	removeStatusBarIcon() {
		if (this.statusBarItem) {
			this.statusBarItem.remove();
			this.statusBarItem = null;
		}
	}

	onunload() {
		// Stop auto sync when plugin is unloaded
		this.stopAutoSync();
		
		// Remove all icons
		this.removeAllIcons();
		
		// Remove status bar icon
		this.removeStatusBarIcon();
		
		// Clear search timeouts to prevent memory leaks
		if (this.cloudSearchTimeout) {
			clearTimeout(this.cloudSearchTimeout);
		}
		if (this.localSearchTimeout) {
			clearTimeout(this.localSearchTimeout);
		}
		
		// Clean up any global preview styles
		const existingStyle = document.getElementById('css-snippets-preview-style');
		if (existingStyle) {
			existingStyle.remove();
		}
		
		// 强制清理任何可能残留的禁用状态，确保不影响全局输入
		this.forceRestoreAllInputStates();
		
		console.log('CSS Snippets Manager plugin unloaded');
	}

	startAutoSync() {
		if (!this.settings.enableAutoSync || this.autoSyncTimer) {
			return;
		}

		const intervalMs = this.settings.autoSyncInterval * 60 * 1000; // Convert minutes to milliseconds
		
		this.autoSyncTimer = setInterval(async () => {
			try {
				// Check if sync is already in progress
				if (this.syncInProgress) {
					console.log('Auto sync skipped - sync already in progress');
					return;
				}
				
				this.syncInProgress = true;
				console.log('Auto sync triggered');
				const result = await this.syncManager.bidirectionalSync();
				if (result.success) {
					console.log('Auto sync completed successfully');
					// Update repo info
					if (this.settings.repoInfo) {
						this.settings.repoInfo.lastSync = Date.now();
						await this.saveSettings();
					}
				} else {
					console.warn('Auto sync failed:', result.message);
				}
			} catch (error) {
				console.error('Auto sync error:', error);
			} finally {
				this.syncInProgress = false;
			}
		}, intervalMs);

		console.log(`Auto sync started with ${this.settings.autoSyncInterval} minute interval`);
	}

	stopAutoSync() {
		if (this.autoSyncTimer) {
			clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
			console.log('Auto sync stopped');
		}
	}

	// Safe sync methods with locking mechanism
	/**
	 * 网络连接诊断
	 */
	async diagnoseNetworkConnection(): Promise<void> {
		new Notice('开始网络诊断...');
		
		const results: string[] = [];
		
		try {
			// 1. 测试基本的GitHub API可达性
			results.push('🌐 网络连接诊断报告');
			results.push('='.repeat(30));
			
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
				
				const response = await fetch('https://api.github.com', { 
					method: 'GET',
					signal: controller.signal
				});
				clearTimeout(timeoutId);
				results.push(`✅ GitHub API基础连接: ${response.status} ${response.statusText}`);
			} catch (error) {
				results.push(`❌ GitHub API基础连接失败: ${error instanceof Error ? error.message : '未知错误'}`);
			}
			
			// 2. 测试GitHub认证端点
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
				
				const response = await fetch('https://api.github.com/user', { 
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.settings.githubToken}`,
						'User-Agent': 'CSS-Snippets-Manager'
					},
					signal: controller.signal
				});
				clearTimeout(timeoutId);
				
				if (response.status === 200) {
					const userData = await response.json();
					results.push(`✅ Token认证成功: ${userData.login || '未知用户'}`);
				} else if (response.status === 401) {
					results.push('❌ Token认证失败: Token无效或已过期');
				} else {
					results.push(`⚠️ Token认证异常: ${response.status} ${response.statusText}`);
				}
			} catch (error) {
				results.push(`❌ Token认证测试失败: ${error instanceof Error ? error.message : '未知错误'}`);
			}
			
			// 3. 测试仓库访问
			if (this.settings.githubRepoUrl) {
				const validation = SecurityUtils.validateGitHubRepoUrl(this.settings.githubRepoUrl);
				if (validation.valid) {
					const repoPath = `${validation.owner}/${validation.repo}`;
					try {
						const controller = new AbortController();
						const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
						
						const response = await fetch(`https://api.github.com/repos/${repoPath}`, {
							method: 'GET',
							headers: {
								'Authorization': `Bearer ${this.settings.githubToken}`,
								'User-Agent': 'CSS-Snippets-Manager'
							},
							signal: controller.signal
						});
						clearTimeout(timeoutId);
						
						if (response.status === 200) {
							const repoData = await response.json();
							results.push(`✅ 仓库访问成功: ${repoData.full_name}`);
							results.push(`📊 仓库信息: ${repoData.private ? '私有' : '公开'}, ${repoData.size}KB`);
						} else if (response.status === 404) {
							results.push('❌ 仓库不存在或无访问权限');
						} else {
							results.push(`⚠️ 仓库访问异常: ${response.status} ${response.statusText}`);
						}
					} catch (error) {
						results.push(`❌ 仓库访问测试失败: ${error instanceof Error ? error.message : '未知错误'}`);
					}
				} else {
					results.push(`❌ 仓库URL格式错误: ${validation.message}`);
				}
			} else {
				results.push('⚠️ 未配置仓库URL，跳过仓库访问测试');
			}
			
			// 4. 显示系统信息
			results.push('');
			results.push('📋 系统信息:');
			results.push(`   浏览器: ${navigator.userAgent.split(' ')[0]}`);
			results.push(`   当前时间: ${new Date().toLocaleString()}`);
			
		} catch (error) {
			results.push(`💥 诊断过程异常: ${error instanceof Error ? error.message : '未知错误'}`);
		}
		
		// 显示诊断结果
		const reportText = results.join('\n');
		console.log('🔍 网络诊断报告:\n' + reportText);
		
		// 创建模态窗口显示结果
		const modal = document.createElement('div');
		modal.className = 'modal-container mod-dim';
		modal.onclick = () => modal.remove();
		
		const modalContent = modal.createEl('div', { cls: 'modal' });
		modalContent.onclick = (e) => e.stopPropagation();
		
		modalContent.createEl('h3', { text: '网络连接诊断报告' });
		
		const reportEl = modalContent.createEl('pre', { text: reportText });
		reportEl.style.maxHeight = '400px';
		reportEl.style.overflow = 'auto';
		reportEl.style.fontSize = '12px';
		reportEl.style.background = 'var(--background-secondary)';
		reportEl.style.padding = '15px';
		reportEl.style.borderRadius = '5px';
		reportEl.style.marginTop = '10px';
		reportEl.style.whiteSpace = 'pre-wrap';
		
		const closeBtn = modalContent.createEl('button', { text: '关闭', cls: 'mod-cta' });
		closeBtn.onclick = () => modal.remove();
		closeBtn.style.marginTop = '15px';
		
		document.body.appendChild(modal);
		
		new Notice('网络诊断完成，请查看详细报告');
	}

	/**
	 * 测试上传下载编码一致性（调试方法）
	 */
	async testEncodingConsistency(): Promise<void> {
		if (!this.settings.githubToken || !this.settings.githubRepoUrl) {
			this.requireGitHubConfig();
			return;
		}

		const testContent = `/* 测试编码一致性 */
.test-class {
	/* 中文注释 */
	color: #ff0000;
	background: url("test.png");
	content: "测试文本";
}

/* 包含特殊字符: ©®™ */
`;

		try {
			new Notice('正在测试编码一致性...');
			const result = await this.syncManager.verifyUploadDownloadConsistency(testContent);
			
			if (result.consistent) {
				new Notice(`✅ 编码一致性测试通过！哈希值: ${result.originalHash}`);
			} else {
				new Notice(`❌ 编码不一致！原始: ${result.originalHash}, 下载: ${result.downloadedHash}`);
				console.error('Encoding inconsistency detected:', result);
			}
		} catch (error) {
			this.showErrorNotice('测试', error);
			console.error('Encoding test error:', error);
		}
	}

	async performSafeSync(syncType: 'bidirectional' | 'toCloud' | 'fromCloud', options: any = {}): Promise<any> {
		if (this.syncInProgress) {
			return { success: false, message: '同步正在进行中，请稍后再试' };
		}

		this.syncInProgress = true;
		try {
			switch (syncType) {
				case 'bidirectional':
					return await this.syncManager.bidirectionalSync(options);
				case 'toCloud':
					return await this.syncManager.syncToCloud(options);
				case 'fromCloud':
					return await this.syncManager.syncFromCloud(options);
				default:
					return { success: false, message: '未知的同步类型' };
			}
		} finally {
			this.syncInProgress = false;
		}
	}

	// Cache management methods
	// 🔥 新的实时云端文件获取系统 - 无缓存，直接获取最新数据
	async getRealtimeCloudFiles(): Promise<GitHubFile[]> {
		return this.measurePerformance('实时获取云端文件列表', async () => {
			try {
				console.log('🔄 实时获取GitHub仓库文件列表...');
				const files = await this.githubClient.listFiles();
				console.log(`✅ 成功获取 ${files.length} 个云端文件`);
				return files;
			} catch (error) {
				console.error('❌ 获取云端文件失败:', error);
				throw error;
			}
		});
	}

	// 🔥 操作后等待GitHub API同步的智能延迟系统
	async waitForGitHubSync(operationType: string, delayMs: number = 800): Promise<void> {
		console.log(`⏳ 等待GitHub API同步完成 (${operationType}): ${delayMs}ms`);
		await new Promise(resolve => setTimeout(resolve, delayMs));
		console.log(`✅ GitHub API同步等待完成 (${operationType})`);
	}

	async getCachedLocalSnippets(): Promise<LocalSnippet[]> {
		return this.measurePerformance('获取本地代码片段', async () => {
			const now = Date.now();
			if (this.localSnippetsCache && (now - this.localSnippetsCache.timestamp) < this.CACHE_EXPIRY_MS) {
				console.log('Using cached local snippets');
				return this.localSnippetsCache.snippets;
			}
			
			console.log('Fetching fresh local snippets');
			const snippets = await this.localManager.getSnippetsList();
			this.localSnippetsCache = { snippets, timestamp: now };
			return snippets;
		});
	}

	invalidateLocalCache() {
		this.localSnippetsCache = null;
		console.log('Local cache invalidated');
	}

	clearAllCaches() {
		// 只清除本地snippets缓存，cloudFilesCache已不再使用
		this.localSnippetsCache = null;
		console.log('Local snippets cache cleared');
	}

	// Performance monitoring
	private logPerformance(operation: string, duration: number) {
		this.performanceLog.push({
			operation,
			duration,
			timestamp: Date.now()
		});
		
		// Keep log size under control
		if (this.performanceLog.length > this.MAX_PERFORMANCE_LOG_SIZE) {
			this.performanceLog = this.performanceLog.slice(-this.MAX_PERFORMANCE_LOG_SIZE);
		}
		
		// Log slow operations
		if (duration > 1000) {
			console.warn(`🐌 CSS Snippets Manager: 操作 "${operation}" 耗时 ${duration}ms`);
		}
	}

	private async measurePerformance<T>(operation: string, fn: () => Promise<T>): Promise<T> {
		const startTime = Date.now();
		try {
			const result = await fn();
			this.logPerformance(operation, Date.now() - startTime);
			return result;
		} catch (error) {
			this.logPerformance(`${operation} (错误)`, Date.now() - startTime);
			throw error;
		}
	}

	getPerformanceStats() {
		const recentLog = this.performanceLog.filter(entry => 
			Date.now() - entry.timestamp < 60 * 60 * 1000 // Last hour
		);
		
		const stats: Record<string, { count: number, avgDuration: number, maxDuration: number }> = {};
		
		recentLog.forEach(entry => {
			if (!stats[entry.operation]) {
				stats[entry.operation] = { count: 0, avgDuration: 0, maxDuration: 0 };
			}
			stats[entry.operation].count++;
			stats[entry.operation].maxDuration = Math.max(stats[entry.operation].maxDuration, entry.duration);
		});
		
		// Calculate averages
		Object.keys(stats).forEach(operation => {
			const entries = recentLog.filter(entry => entry.operation === operation);
			const totalDuration = entries.reduce((sum, entry) => sum + entry.duration, 0);
			stats[operation].avgDuration = totalDuration / entries.length;
		});
		
		return stats;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		
		// 如果启用了Token加密且存在加密Token，则解密
		if (this.settings.enableTokenEncryption && this.settings.githubTokenEncrypted) {
			this.settings.githubToken = SecurityUtils.decryptToken(this.settings.githubTokenEncrypted);
		}
	}

	async saveSettings() {
		// 如果启用了Token加密，加密Token后保存
		if (this.settings.enableTokenEncryption && this.settings.githubToken) {
			this.settings.githubTokenEncrypted = SecurityUtils.encryptToken(this.settings.githubToken);
			// 不保存明文Token到磁盘
			const settingsToSave = { ...this.settings };
			settingsToSave.githubToken = '';
			await this.saveData(settingsToSave);
		} else {
			await this.saveData(this.settings);
		}
		
		// 更新GitHub client凭据
		if (this.githubClient && this.settings.githubToken && this.settings.githubRepoUrl) {
			const repoPath = this.convertGitHubUrl(this.settings.githubRepoUrl);
			this.githubClient.updateCredentials(this.settings.githubToken, repoPath);
		}
	}

	// 🔧 统一的错误处理和提示功能
	showErrorNotice(operation: string, error: unknown, fallbackMessage?: string): void {
		const errorMessage = error instanceof Error ? error.message : (fallbackMessage || '未知错误');
		new Notice(`❌ ${operation}失败: ${errorMessage}`);
	}

	// 🔧 配置验证通知工具 (插件类中的方法)
	requireGitHubConfig(): boolean {
		new Notice('⚙️ 请先在设置中配置 GitHub 仓库信息');
		return false;
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_CSS_SNIPPETS_MANAGER);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for the view
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE_CSS_SNIPPETS_MANAGER, active: true });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		workspace.revealLeaf(leaf);
	}

	// 强制恢复所有输入状态，在插件卸载时清理可能的残留状态
	forceRestoreAllInputStates() {
		try {
			// 获取View实例并调用其恢复方法
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CSS_SNIPPETS_MANAGER);
			if (leaves.length > 0) {
				const view = leaves[0].view;
				if (view instanceof CSSSnippetsManagerView) {
					view.restoreInputsAndFocus('cloud', '');
					view.restoreInputsAndFocus('local', '');
				}
			}
			
			// 额外安全措施：清理任何可能残留的禁用类
			const allInputs = document.querySelectorAll('.css-snippets-input-disabled, .css-snippets-btn-disabled');
			allInputs.forEach(element => {
				if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
					element.disabled = false;
					element.classList.remove('css-snippets-input-disabled', 'css-snippets-btn-disabled');
				}
			});
			
			console.log('[CSS Snippets Manager] 已强制清理所有输入状态');
		} catch (error) {
			console.error('[CSS Snippets Manager] 强制清理输入状态时出错:', error);
		}
	}
}

// CSS Snippets Manager Main View
class CSSSnippetsManagerView extends ItemView {
	plugin: CSSSnippetsManagerPlugin;
	private currentTab: 'cloud' | 'local' | 'editor' = 'local';
	private searchQuery: string = '';
	private isSearchActive: boolean = false;
	private localSortBy: 'name' | 'time' = 'time'; // 默认按修改时间排序
	private cloudSortBy: 'name' | 'time' = 'time'; // 云端排序默认按修改时间排序
	private isRenderingLocal: boolean = false; // 本地列表渲染状态
	private isRenderingCloud: boolean = false; // 云端列表渲染状态

	constructor(leaf: WorkspaceLeaf, plugin: CSSSnippetsManagerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	// 🔧 统一按钮创建工厂函数 - 避免重复代码
	private createButton(
		container: HTMLElement, 
		text: string, 
		cssClass: string = 'css-snippets-btn', 
		icon?: string
	): HTMLButtonElement {
		const buttonText = icon ? `${icon} ${text}` : text;
		return container.createEl('button', {
			text: buttonText,
			cls: cssClass
		});
	}

	// 🔧 创建带多个CSS类的按钮
	private createButtonWithClasses(
		container: HTMLElement,
		text: string,
		classes: string[],
		icon?: string
	): HTMLButtonElement {
		const buttonText = icon ? `${icon} ${text}` : text;
		return container.createEl('button', {
			text: buttonText,
			cls: classes.join(' ')
		});
	}

	// 🔧 统一的错误处理和提示功能
	// 🔧 统一的列表更新通知系统
	private showListUpdateNotice(
		listType: 'local' | 'cloud' | 'both',
		operation: string,
		itemName?: string
	): void {
		const typeMap = {
			'local': '本地列表',
			'cloud': '云端列表', 
			'both': '列表'
		};
		
		const listDesc = typeMap[listType];
		
		if (itemName) {
			new Notice(`✅ ${itemName} ${operation}完成，${listDesc}已更新`);
		} else {
			new Notice(`✅ ${operation}完成，${listDesc}已更新`);
		}
	}

	// 🔧 持续通知管理工具
	private createPersistentNotice(message: string): { 
		hide: () => void,
		complete: (successMessage: string) => void,
		fail: (errorMessage: string) => void 
	} {
		const notice = new Notice(message, 0);
		
		return {
			hide: () => notice.hide(),
			complete: (successMessage: string) => {
				notice.hide();
				new Notice(successMessage);
			},
			fail: (errorMessage: string) => {
				notice.hide();
				new Notice(errorMessage);
			}
		};
	}

	// 🔧 标准化文件操作通知格式
	private showFileOperationNotice(
		action: string,
		fileName: string,
		format: 'action_completed' | 'object_processed' | 'state_changed' = 'action_completed'
	): void {
		switch (format) {
			case 'action_completed':
				new Notice(`✅ ${action}完成: ${fileName}`);
				break;
			case 'object_processed':
				new Notice(`✅ ${fileName} ${action}完成`);
				break;
			case 'state_changed':
				new Notice(`✅ ${fileName} 状态已更改`);
				break;
		}
	}

	// 🔧 配置验证通知工具
	private requireGitHubConfig(): boolean {
		new Notice('⚙️ 请先在设置中配置 GitHub 仓库信息');
		return false;
	}

	private requireInput(inputType: string): boolean {
		new Notice(`📝 请输入${inputType}`);
		return false;
	}

	private showValidationError(field: string, errors: string[]): void {
		new Notice(`❌ ${field}验证失败: ${errors.join(', ')}`);
	}

	getViewType() {
		return VIEW_TYPE_CSS_SNIPPETS_MANAGER;
	}

	getDisplayText() {
		return "CSS Snippets Manager";
	}

	getIcon() {
		return "code";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();

		// Create tab navigation
		this.createTabNavigation(container);

		// Create tab content container
		const tabContentContainer = container.createEl("div", { cls: "css-snippets-tab-content" });

		// Create the three main sections as tabs
		this.createCloudTab(tabContentContainer);
		this.createLocalTab(tabContentContainer);
		this.createEditorTab(tabContentContainer);

		// Show initial tab
		this.showTab(this.currentTab);

		// Load initial data - 默认自动刷新且不提示
		await this.refreshListsSilently();
	}

	async onClose() {
		// Clean up any preview styles when view is closed
		const existingStyle = document.getElementById('css-snippets-preview-style');
		if (existingStyle) {
			existingStyle.remove();
		}
	}

	createTabNavigation(container: Element) {
		const tabNav = container.createEl("div", { cls: "css-snippets-tab-nav" });
		
		// 云端模块 - 使用云朵图标
		const cloudTab = tabNav.createEl("button", { 
			cls: "css-snippets-tab-button",
			attr: { "data-tab": "cloud" }
		});
		cloudTab.innerHTML = '<svg class="svg-icon lucide-cloud" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg> 云端模块';
		cloudTab.onclick = () => this.showTab('cloud');
		
		// 本地模块 - 使用硬盘图标  
		const localTab = tabNav.createEl("button", { 
			cls: "css-snippets-tab-button",
			attr: { "data-tab": "local" }
		});
		localTab.innerHTML = '<svg class="svg-icon lucide-hard-drive" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg> 本地模块';
		localTab.onclick = () => this.showTab('local');
		
		// 编辑模块 - 使用编辑图标
		const editorTab = tabNav.createEl("button", { 
			cls: "css-snippets-tab-button",
			attr: { "data-tab": "editor" }
		});
		editorTab.innerHTML = '<svg class="svg-icon lucide-edit" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg> 编辑模块';
		editorTab.onclick = () => this.showTab('editor');
	}

	showTab(tabName: 'cloud' | 'local' | 'editor') {
		this.currentTab = tabName;
		
		// Update tab button states
		const tabButtons = this.containerEl.querySelectorAll('.css-snippets-tab-button');
		tabButtons.forEach(button => {
			const buttonElement = button as HTMLElement;
			const tabData = buttonElement.getAttribute('data-tab');
			if (tabData === tabName) {
				buttonElement.addClass('active');
			} else {
				buttonElement.removeClass('active');
			}
		});
		
		// Show/hide tab content
		const tabContents = this.containerEl.querySelectorAll('.css-snippets-tab-panel');
		tabContents.forEach(content => {
			const contentElement = content as HTMLElement;
			const tabData = contentElement.getAttribute('data-tab');
			if (tabData === tabName) {
				contentElement.style.display = 'block';
			} else {
				contentElement.style.display = 'none';
			}
		});
		
		// 🚀 自动同步GitHub仓库信息
		if (tabName === 'cloud') {
			this.autoSyncCloudData();
		}
	}

	// 🚀 自动同步云端数据方法
	async autoSyncCloudData() {
		try {
			// 检查GitHub配置
			if (!this.plugin.settings.githubToken || !this.plugin.settings.githubRepoUrl) {
				console.log('GitHub配置未完成，跳过自动同步');
				return;
			}

			// 防止频繁同步 - 检查上次同步时间
			const now = Date.now();
			const lastSync = this.plugin.lastCloudSync || 0;
			const syncInterval = 30000; // 30秒内不重复同步

			if (now - lastSync < syncInterval) {
				console.log('同步间隔过短，跳过自动同步');
				return;
			}

			// 更新同步时间戳
			this.plugin.lastCloudSync = now;

			// 创建持续提示
			const syncNotice = new Notice("🔄 正在同步GitHub仓库信息...", 0);

			// 使用统一的云端列表管理系统进行自动同步
			await this.renderCloudList({
				searchQuery: this.isSearchActive ? this.searchQuery : '',
				showProgress: false,
				operation: "自动同步"
			});

			// 关闭同步提示并显示结果
			syncNotice.hide();

			// 显示同步结果
			this.showFileOperationNotice('sync', 'GitHub仓库信息', 'action_completed');

		} catch (error) {
			console.error('自动同步失败:', error);
			// 静默失败，不显示错误提示影响用户体验
		}
	}

	createCloudTab(container: Element) {
		const cloudTab = container.createEl("div", { 
			cls: "css-snippets-tab-panel",
			attr: { "data-tab": "cloud" }
		});
		
		// Search and refresh container
		const cloudSearchDiv = cloudTab.createEl("div", { cls: "css-snippets-search css-snippets-search-with-action" });
		const cloudSearchInput = cloudSearchDiv.createEl("input", { 
			type: "text", 
			placeholder: "搜索云端 CSS 片段...",
			cls: "css-snippets-search-input css-snippets-search-input-shortened"
		}) as HTMLInputElement;
		
		// Clear all search button (moved to first position)
		const cloudClearAllBtn = this.createButtonWithClasses(
			cloudSearchDiv,
			"清空",
			["css-snippets-btn", "css-snippets-search-action-btn"],
			"🗑️"
		);
		cloudClearAllBtn.onclick = () => {
			cloudSearchInput.value = '';
			this.handleCloudSearch('');
		};
		
		// One-click delete all button (moved after clear button)
		const cloudDeleteAllBtn = this.createButtonWithClasses(
			cloudSearchDiv,
			"一键删除",
			["css-snippets-btn", "css-snippets-search-action-btn"],
			"🗑️"
		);
		cloudDeleteAllBtn.onclick = async () => {
			// 使用模态窗口确认删除，避免焦点问题
			const activeElement = document.activeElement as HTMLElement;
			
			// 显示模态确认窗口
			this.showDeleteConfirmModal("所有云端CSS文件", async () => {
				// 创建持续的删除提示
				const deleteNotice = new Notice("正在删除云端所有CSS文件...", 0); // 0表示不自动消失
				
				try {
					// 获取所有云端文件
					const files = await this.plugin.githubClient.listFiles();
					
					if (files.length === 0) {
						deleteNotice.hide(); // 关闭持续提示
						new Notice("❌ 没有找到可删除的云端文件");
						// 恢复焦点
						setTimeout(() => {
							if (activeElement && activeElement.isConnected) {
								activeElement.focus();
							}
						}, 100);
						return;
					}
					
					// 删除所有文件
					let successCount = 0;
					let failCount = 0;
					
					for (const file of files) {
						try {
							await this.plugin.githubClient.deleteFile(file.path);
						successCount++;
					} catch (error) {
						failCount++;
						console.error(`删除文件 ${file.name} 失败:`, error);
					}
				}
				
					deleteNotice.hide(); // 关闭删除提示
					
					// 显示删除结果
					if (failCount === 0) {
						new Notice(`✅ 成功删除 ${successCount} 个CSS文件`);
					} else {
						new Notice(`⚠️ 删除完成：成功 ${successCount} 个，失败 ${failCount} 个`);
					}
					
					// 等待GitHub API处理
					await new Promise(resolve => setTimeout(resolve, 2000));
					
					// 🚀 强制更新同步时间戳以确保立即同步
					this.plugin.lastCloudSync = 0;
					
					// 自动同步GitHub仓库信息
					await this.autoSyncCloudData();
					
					// 恢复焦点
					setTimeout(() => {
						if (activeElement && activeElement.isConnected) {
							activeElement.focus();
						}
					}, 100);
					
				} catch (error) {
					deleteNotice.hide(); // 确保在出错时也关闭持续提示
					this.plugin.showErrorNotice('删除', error);
					// 恢复焦点
					setTimeout(() => {
						if (activeElement && activeElement.isConnected) {
							activeElement.focus();
						}
					}, 100);
				}
			});
		};
		
		// Refresh button (moved to search bar)
		const cloudRefreshBtn = this.createButtonWithClasses(
			cloudSearchDiv,
			"刷新",
			["css-snippets-btn", "css-snippets-search-action-btn"],
			"🔄"
		);
		cloudRefreshBtn.onclick = async () => {
			// 🚀 使用增强的实时云端列表管理系统进行强制刷新
			const refreshNotice = this.createPersistentNotice("🔄 正在强制刷新GitHub仓库信息...");

			try {
				await this.renderCloudList();
				// 直接显示最终结果，避免重复通知
				refreshNotice.complete("✅ 刷新完成，云端列表已更新");

			} catch (error) {
				refreshNotice.fail("❌ 刷新失败");
				console.error('手动刷新失败:', error);
				this.plugin.showErrorNotice('刷新', error, '网络或配置错误');
			}
		};

		// Sort toggle button (switches between name and time)
		const cloudSortToggleBtn = this.createButtonWithClasses(cloudSearchDiv, "🕒 按时间", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);
		
		// Function to update sort button display
		const updateCloudSortButton = () => {
			if (this.cloudSortBy === 'name') {
				cloudSortToggleBtn.textContent = "🔤 按名称";
			} else {
				cloudSortToggleBtn.textContent = "🕒 按时间";
			}
		};
		
		updateCloudSortButton(); // Initialize button display
		
		cloudSortToggleBtn.onclick = async () => {
			// Toggle between name and time sorting
			this.cloudSortBy = this.cloudSortBy === 'name' ? 'time' : 'name';
			updateCloudSortButton();
			// 🚀 使用统一的云端列表管理系统（自动处理搜索状态）
			await this.renderCloudList({
				searchQuery: this.isSearchActive ? this.searchQuery : '',
				showProgress: false,
				operation: "排序切换"
			});
		};

		// GitHub repository access button
		const githubBtn = this.createButtonWithClasses(cloudSearchDiv, "☁️ 访问仓库", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);
		githubBtn.onclick = () => {
			if (!this.plugin.settings.githubRepoUrl) {
				this.requireGitHubConfig();
				return;
			}
			
			try {
				// 构建 GitHub 仓库 URL
				let repoUrl = this.plugin.settings.githubRepoUrl;
				
				// 如果是 owner/repo 格式，转换为完整 URL
				if (!repoUrl.startsWith('http')) {
					repoUrl = `https://github.com/${repoUrl}`;
				}
				
				// 使用 Electron 的 shell 打开外部链接
				if ((window as any).require) {
					const { shell } = (window as any).require('electron');
					shell.openExternal(repoUrl);
				} else {
					// 备用方案：使用 window.open
					window.open(repoUrl, '_blank');
				}
				
				new Notice('正在打开 GitHub 仓库...');
			} catch (error) {
				console.error('Error opening GitHub repository:', error);
				new Notice('打开仓库失败，请手动访问 GitHub 仓库');
			}
		};
		
		// Search event listeners
		cloudSearchInput.addEventListener('input', (e) => {
			const query = (e.target as HTMLInputElement).value;
			
			// Debounce search to improve performance
			if (this.plugin.cloudSearchTimeout) {
				clearTimeout(this.plugin.cloudSearchTimeout);
			}
			this.plugin.cloudSearchTimeout = setTimeout(() => {
				this.handleCloudSearch(query);
			}, 300); // 300ms debounce
		});

		// Focus event to show ready state when search box is focused but empty
		cloudSearchInput.addEventListener('focus', () => {
			if (!cloudSearchInput.value.trim()) {
				this.updateCloudSearchInfo("", 0, true); // 显示准备搜索状态
			}
		});

		// Blur event to show list info when search box loses focus and is empty
		cloudSearchInput.addEventListener('blur', () => {
			if (!cloudSearchInput.value.trim()) {
				// 🔧 修复：增加延迟时间，避免与确认对话框和删除操作冲突
				setTimeout(() => {
					// 🔧 修复：检查是否还在DOM中且仍然为空
					if (cloudSearchInput.isConnected && !cloudSearchInput.value.trim() && !document.querySelector('.modal')) {
						const items = this.containerEl.querySelectorAll('.css-snippets-cloud-list .css-snippets-item');
						this.updateCloudSearchInfo("", items.length, false); // 显示列表信息状态
					}
				}, 300); // 增加延迟时间
			}
		});

		// Search result info container
		const cloudSearchInfoDiv = cloudTab.createEl("div", { cls: "css-snippets-search-info list-info" });
		cloudSearchInfoDiv.createEl("span", { 
			text: "正在加载云端片段...", 
			cls: "css-snippets-search-info-text" 
		});

		// Cloud snippets list container
		const cloudListDiv = cloudTab.createEl("div", { cls: "css-snippets-cloud-list" });
		cloudListDiv.createEl("p", { text: "云端 CSS 片段将在此显示..." });

	}

	createLocalTab(container: Element) {
		const localTab = container.createEl("div", { 
			cls: "css-snippets-tab-panel",
			attr: { "data-tab": "local" }
		});
		
		// Search and sync container
		const localSearchDiv = localTab.createEl("div", { cls: "css-snippets-search css-snippets-search-with-multiple-actions" });
		const localSearchInput = localSearchDiv.createEl("input", { 
			type: "text", 
			placeholder: "搜索本地 CSS 片段...",
			cls: "css-snippets-search-input css-snippets-search-input-shortened"
		}) as HTMLInputElement;
		
		// Clear all search button (moved to first position)
		const localClearAllBtn = this.createButtonWithClasses(localSearchDiv, "🗑️ 清空", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);
		localClearAllBtn.onclick = () => {
			localSearchInput.value = '';
			this.handleLocalSearch('');
		};
		
		// Incremental sync button (moved after clear button)
		const localSyncBtn = this.createButtonWithClasses(localSearchDiv, "📤 增量同步", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);
		localSyncBtn.onclick = async () => {
			// 使用统一的持续通知管理
			const syncProgress = this.createPersistentNotice("🔄 正在进行增量同步（基于哈希值比较）...");
			try {
				// 使用新的增量同步系统 - 基于文件哈希值的真正增量同步
				const result = await this.plugin.performSafeSync('toCloud', { useSecureHash: true });
				
				if (result.success) {
					const details = result.details;
					let message = `✅ 增量同步成功！`;
					
					// 详细统计信息
					const stats: string[] = [];
					if (details?.uploaded?.length > 0) {
						stats.push(`新增 ${details.uploaded.length} 个`);
					}
					if (details?.updated?.length > 0) {
						stats.push(`更新 ${details.updated.length} 个`);
					}
					if (details?.skipped?.length > 0) {
						stats.push(`跳过 ${details.skipped.length} 个相同`);
					}
					
					if (stats.length > 0) {
						message += ` ${stats.join('，')}文件`;
					}
					
					if (details?.totalTime) {
						const timeStr = details.totalTime > 1000 
							? `${(details.totalTime / 1000).toFixed(1)}秒`
							: `${details.totalTime}毫秒`;
						message += `，耗时 ${timeStr}`;
					}
					
					// 关闭同步提示，刷新列表并显示统一的列表更新通知
					syncProgress.hide();
					const refreshProgress = this.createPersistentNotice("🔄 正在刷新云端列表...");
					await this.renderCloudList();
					refreshProgress.complete("✅ 同步完成，云端列表已更新");
					
				} else {
					if (result.conflicts && result.conflicts.length > 0) {
						// 有冲突时询问是否覆盖
						const conflictMessage = `发现 ${result.conflicts.length} 个文件内容不同：\n${result.conflicts.join(', ')}\n\n是否覆盖云端文件？`;
						const overwrite = confirm(conflictMessage);
						
						if (overwrite) {
							syncProgress.hide();
							const overwriteProgress = this.createPersistentNotice("🔄 正在覆盖云端文件（强制同步）...");
							const overwriteResult = await this.plugin.performSafeSync('toCloud', { 
								forceOverwrite: true, 
								useSecureHash: true 
							});
							
							if (overwriteResult.success) {
								const details = overwriteResult.details;
								let message = `✅ 强制同步成功！覆盖了 ${details?.updated?.length || 0} 个文件`;
								if (details?.totalTime) {
									const timeStr = details.totalTime > 1000 
										? `${(details.totalTime / 1000).toFixed(1)}秒`
										: `${details.totalTime}毫秒`;
									message += `，耗时 ${timeStr}`;
								}
								
								// 刷新列表并使用统一通知
								overwriteProgress.hide();
								const refreshProgress = this.createPersistentNotice("🔄 正在刷新云端列表...");
								await this.renderCloudList();
								refreshProgress.complete("✅ 强制同步完成，云端列表已更新");
							} else {
								overwriteProgress.fail(`❌ 覆盖失败：${overwriteResult.message || '请检查网络连接和GitHub设置'}`);
							}
						} else {
							syncProgress.fail(`⚠️ 同步已取消：${result.message || '存在文件冲突'}`);
						}
					} else {
						syncProgress.fail(`❌ 同步失败：${result.message || '请检查网络连接和GitHub设置'}`);
					}
				}
			} catch (error) {
				syncProgress.fail('❌ 增量同步异常');
				console.error('Incremental sync error:', error);
				this.plugin.showErrorNotice('增量同步', error, '未知错误，请检查网络连接和GitHub设置');
			}
		};
		
		// Open local folder button
		const openFolderBtn = this.createButtonWithClasses(localSearchDiv, "📁 打开文件夹", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);
		openFolderBtn.onclick = async () => {
			try {
				const snippetsPath = this.plugin.localManager.getSnippetsPath();
				const basePath = (this.plugin.app.vault.adapter as any).basePath || '';
				const fullPath = require('path').join(basePath, snippetsPath);
				
				// 使用 Electron 的 shell 模块打开文件夹（类似 MySnippets 插件的方式）
				const { shell } = require('electron');
				await shell.openPath(fullPath);
				// 移除成功提示，让操作更简洁
				// new Notice("✅ 已打开本地CSS片段文件夹");
			} catch (error) {
				this.plugin.showErrorNotice('打开文件夹', error);
			}
		};
		
		// Refresh local list button
		const localRefreshBtn = this.createButtonWithClasses(localSearchDiv, "🔄 刷新", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);
		localRefreshBtn.onclick = async () => {
			// 🚀 使用新的统一列表渲染系统进行本地手动刷新
			await this.renderLocalList({
				searchQuery: this.isSearchActive ? this.searchQuery : '',
				showProgress: true,
				operation: '手动刷新'
			});
		};

		// Sort toggle button (switches between name and time)
		const localSortToggleBtn = this.createButtonWithClasses(localSearchDiv, "🕒 按时间", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);
		
		// Function to update sort button display
		const updateSortButton = () => {
			if (this.localSortBy === 'name') {
				localSortToggleBtn.textContent = "🔤 按名称";
			} else {
				localSortToggleBtn.textContent = "🕒 按时间";
			}
		};
		
		updateSortButton(); // Initialize button display
		
		localSortToggleBtn.onclick = async () => {
			// Toggle between name and time sorting
			this.localSortBy = this.localSortBy === 'name' ? 'time' : 'name';
			updateSortButton();
			if (localSearchInput.value.trim()) {
				this.handleLocalSearch(localSearchInput.value.trim());
			} else {
				// 🚀 使用新的统一列表渲染系统
				await this.renderLocalList({
					searchQuery: '',
					showProgress: false,
					operation: '排序切换'
				});
			}
		};
		
		// Search event listeners
		localSearchInput.addEventListener('input', (e) => {
			const query = (e.target as HTMLInputElement).value;
			
			// Debounce search to improve performance
			if (this.plugin.localSearchTimeout) {
				clearTimeout(this.plugin.localSearchTimeout);
			}
			this.plugin.localSearchTimeout = setTimeout(() => {
				this.handleLocalSearch(query);
			}, 300); // 300ms debounce
		});

		// Focus event to show ready state when search box is focused but empty
		localSearchInput.addEventListener('focus', () => {
			if (!localSearchInput.value.trim()) {
				this.updateLocalSearchInfo("", 0, true); // 显示准备搜索状态
			}
		});

		// Blur event to show list info when search box loses focus and is empty
		localSearchInput.addEventListener('blur', () => {
			if (!localSearchInput.value.trim()) {
				// 🔧 修复：增加延迟时间，避免与确认对话框和删除操作冲突
				setTimeout(() => {
					// 🔧 修复：检查是否还在DOM中且仍然为空
					if (localSearchInput.isConnected && !localSearchInput.value.trim() && !document.querySelector('.modal')) {
						const items = this.containerEl.querySelectorAll('.css-snippets-local-list .css-snippets-item');
						this.updateLocalSearchInfo("", items.length, false); // 显示列表信息状态
					}
				}, 300); // 增加延迟时间
			}
		});

		// Search result info container
		const localSearchInfoDiv = localTab.createEl("div", { cls: "css-snippets-search-info list-info" });
		localSearchInfoDiv.createEl("span", { 
			text: "正在加载本地片段...", 
			cls: "css-snippets-search-info-text" 
		});

		// Local snippets list container
		const localListDiv = localTab.createEl("div", { cls: "css-snippets-local-list" });
		localListDiv.createEl("p", { text: "本地 CSS 片段将在此显示..." });
	}

	createEditorTab(container: Element) {
		const editorTab = container.createEl("div", { 
			cls: "css-snippets-tab-panel",
			attr: { "data-tab": "editor" }
		});
		
		// CSS文件名输入和操作按钮容器 - 与其他模块保持一致的布局
		const editorNameDiv = editorTab.createEl("div", { cls: "css-snippets-search css-snippets-search-with-multiple-actions" });
		const nameInput = editorNameDiv.createEl("input", { 
			type: "text", 
			placeholder: "输入 CSS 文件名（无需.css结尾）...",
			cls: "css-snippets-search-input css-snippets-search-input-shortened"
		}) as HTMLInputElement;
		
		// 操作按钮容器
		const actionButtonsDiv = editorNameDiv.createEl("div", { cls: "css-snippets-editor-action-buttons" });
		
		const saveBtn = this.createButtonWithClasses(actionButtonsDiv, "💾 保存", 
			["css-snippets-btn", "css-snippets-btn-primary", "css-snippets-search-action-btn"]);
		const clearBtn = this.createButtonWithClasses(actionButtonsDiv, "🗑️ 清空", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);
		const formatBtn = this.createButtonWithClasses(actionButtonsDiv, "🎨 格式化", 
			["css-snippets-btn", "css-snippets-search-action-btn"]);

		// 添加描述输入框
		const descriptionInputDiv = editorTab.createEl("div", { cls: "css-snippets-search" });
		const descriptionInput = descriptionInputDiv.createEl("input", { 
			type: "text", 
			placeholder: "输入 CSS 片段的描述信息（可选）...",
			cls: "css-snippets-search-input"
		}) as HTMLInputElement;

		// CSS 代码编辑器
		const codeEditorDiv = editorTab.createEl("div", { cls: "css-snippets-editor-code" });
		codeEditorDiv.createEl("label", { text: "CSS 代码:" });
		const codeTextarea = codeEditorDiv.createEl("textarea", { 
			placeholder: "在此编写 CSS 代码...",
			cls: "css-snippets-code-textarea"
		});
		codeTextarea.rows = 15;

		// 按钮事件处理
		saveBtn.onclick = async () => {
			const filename = nameInput.value.trim();
			const description = descriptionInput.value.trim();
			const content = codeTextarea.value.trim();
			
			if (!filename) {
				this.requireInput('文件名');
				return;
			}
			
			if (!content) {
				this.requireInput('CSS 代码');
				return;
			}
			
			try {
				// Validate CSS content
				const validation = this.plugin.localManager.validateCssContent(content);
				if (!validation.isValid) {
					this.showValidationError('CSS', validation.errors);
					return;
				}
				
				// Save the CSS snippet
				const success = await this.plugin.localManager.writeSnippet(filename, content);
				if (success) {
					this.showFileOperationNotice('保存', filename);
					
					// Auto-enable if setting is enabled
					if (this.plugin.settings.autoEnableNewSnippets) {
						try {
							await this.toggleSnippetWithCache(
								filename.endsWith('.css') ? filename : filename + '.css',
								undefined,
								true // silent
							);
							new Notice(`📝 已自动启用 CSS 片段`);
						} catch (error) {
							console.warn('Auto-enable failed:', error);
						}
					}
					
					// Auto-open in editor if setting is enabled
					if (this.plugin.settings.autoOpenAfterSave) {
						try {
							await this.plugin.localManager.openInEditor(
								filename.endsWith('.css') ? filename : filename + '.css'
							);
						} catch (error) {
							console.warn('Auto-open failed:', error);
							new Notice('⚠️ 无法自动打开编辑器');
						}
					}
					
					// 保存描述信息
					if (description) {
						try {
							const finalFilename = filename.endsWith('.css') ? filename : filename + '.css';
							await this.plugin.descriptionManager.setDescription(finalFilename, description);
						} catch (error) {
							console.warn('Description save failed:', error);
						}
					}
					
					// 🚀 使用新的统一列表渲染系统静默刷新本地列表
					await this.renderLocalList({
						searchQuery: this.isSearchActive ? this.searchQuery : '',
						showProgress: false
					});
					
					// Clear the editor if save was successful
					nameInput.value = '';
					descriptionInput.value = '';
					codeTextarea.value = '';
				} else {
					this.plugin.showErrorNotice('保存', new Error('保存操作未完成'));
				}
			} catch (error) {
				console.error('Save error:', error);
				this.plugin.showErrorNotice('保存', error);
			}
		};

		clearBtn.onclick = () => {
			nameInput.value = '';
			descriptionInput.value = '';
			codeTextarea.value = '';
			// 清空时自动关闭预览
			const previewContainer = editorTab.querySelector('.css-snippets-preview-container') as HTMLElement;
			if (previewContainer) {
				previewContainer.style.display = 'none';
			}
			this.showFileOperationNotice('clear', '编辑器', 'state_changed');
		};

		formatBtn.onclick = () => {
			const content = codeTextarea.value.trim();
			if (!content) {
				new Notice("请先输入 CSS 代码");
				return;
			}
			
			// Simple CSS formatting
			try {
				const formatted = this.formatCSS(content);
				codeTextarea.value = formatted;
				this.showFileOperationNotice('format', '代码', 'action_completed');
			} catch (error) {
				this.plugin.showErrorNotice('格式化', error);
			}
		};

		// CSS 代码编辑器实时输入监听（移除预览功能）
		// 保留这里是为了将来可能的其他功能扩展
		codeTextarea.addEventListener('input', () => {
			// 预览功能已移除，此处预留
		});
	}

	// 更新云端搜索信息显示
	private updateCloudSearchInfo(query: string, resultCount: number = 0, isSearchMode: boolean = true) {
		const cloudListDiv = this.containerEl.querySelector('.css-snippets-cloud-list') as HTMLElement;
		if (!cloudListDiv?.parentElement) return;

		const searchInfoDiv = cloudListDiv.parentElement.querySelector('.css-snippets-search-info') as HTMLElement;
		if (!searchInfoDiv) return;

		const infoSpan = searchInfoDiv.querySelector('.css-snippets-search-info-text') as HTMLElement;
		if (!infoSpan) return;

		// 移除所有状态类
		searchInfoDiv.classList.remove('search-ready', 'search-results', 'search-empty', 'list-info');

		if (!isSearchMode) {
			// 第四种状态：显示列表数量
			infoSpan.textContent = `共 ${resultCount} 个云端片段`;
			searchInfoDiv.classList.add('list-info');
		} else if (!query.trim()) {
			// 第一种状态：准备搜索
			infoSpan.textContent = "准备搜索云端片段...";
			searchInfoDiv.classList.add('search-ready');
		} else if (resultCount === 0) {
			// 第三种状态：未找到结果
			infoSpan.textContent = `未找到包含"${query}"的云端片段`;
			searchInfoDiv.classList.add('search-empty');
		} else {
			// 第二种状态：找到结果
			infoSpan.textContent = `找到 ${resultCount} 个包含"${query}"的云端片段`;
			searchInfoDiv.classList.add('search-results');
		}
	}

	// 更新本地搜索信息显示
	private updateLocalSearchInfo(query: string, resultCount: number = 0, isSearchMode: boolean = true) {
		const localListDiv = this.containerEl.querySelector('.css-snippets-local-list') as HTMLElement;
		if (!localListDiv?.parentElement) return;

		const searchInfoDiv = localListDiv.parentElement.querySelector('.css-snippets-search-info') as HTMLElement;
		if (!searchInfoDiv) return;

		const infoSpan = searchInfoDiv.querySelector('.css-snippets-search-info-text') as HTMLElement;
		if (!infoSpan) return;

		// 移除所有状态类
		searchInfoDiv.classList.remove('search-ready', 'search-results', 'search-empty', 'list-info');

		if (!isSearchMode) {
			// 第四种状态：显示列表数量
			infoSpan.textContent = `共 ${resultCount} 个本地片段`;
			searchInfoDiv.classList.add('list-info');
		} else if (!query.trim()) {
			// 第一种状态：准备搜索
			infoSpan.textContent = "准备搜索本地片段...";
			searchInfoDiv.classList.add('search-ready');
		} else if (resultCount === 0) {
			// 第三种状态：未找到结果
			infoSpan.textContent = `未找到包含"${query}"的本地片段`;
			searchInfoDiv.classList.add('search-empty');
		} else {
			// 第二种状态：找到结果
			infoSpan.textContent = `找到 ${resultCount} 个包含"${query}"的本地片段`;
			searchInfoDiv.classList.add('search-results');
		}
	}

	// 🔍 统一搜索系统 - 避免重复代码
	
	/**
	 * 通用搜索处理函数
	 * @param query 搜索查询字符串
	 * @param type 搜索类型：'local' 或 'cloud'
	 */
	private async handleSearch(query: string, type: 'local' | 'cloud'): Promise<void> {
		this.searchQuery = query;
		this.isSearchActive = query.trim().length > 0;
		
		const renderOptions = {
			searchQuery: query,
			showProgress: false
		};
		
		if (type === 'local') {
			await this.renderLocalList(renderOptions);
		} else {
			await this.renderCloudList(renderOptions);
		}
	}
	
	// 本地搜索功能
	async handleLocalSearch(query: string) {
		await this.handleSearch(query, 'local');
	}

	// 云端搜索功能  
	async handleCloudSearch(query: string) {
		await this.handleSearch(query, 'cloud');
	}

	// Action methods for file operations
	async downloadSnippet(fileName: string) {
		const downloadProgress = this.createPersistentNotice(`正在下载 ${fileName}...`);
		try {
			// Download from GitHub and save locally
			const fileContent = await this.plugin.githubClient.downloadFile(fileName);
			await this.plugin.localManager.writeSnippet(fileName, fileContent);
			
			// 使用统一的文件操作成功通知
			downloadProgress.complete(`✅ ${fileName} 下载完成`);
			
			// Invalidate local cache since we added a new file
			this.plugin.invalidateLocalCache();
			
			// 统一使用renderLocalList刷新，避免重复渲染逻辑
			await this.renderLocalList({
				searchQuery: this.isSearchActive ? this.searchQuery : '',
				showProgress: false,
				operation: '下载完成'
			});
		} catch (error) {
			downloadProgress.fail(`❌ 下载失败: ${error instanceof Error ? error.message : '未知错误'}`);
			console.error('Download error:', error);
		}
	}

	async uploadSnippet(fileName: string) {
		const uploadProgress = this.createPersistentNotice(`正在上传 ${fileName}...`);
		try {
			// Read local file and upload to GitHub
			const fileContent = await this.plugin.localManager.readSnippet(fileName);
			await this.plugin.githubClient.uploadFile(fileName, fileContent);
			
			// 刷新云端列表并显示统一的更新通知
			uploadProgress.hide();
			const refreshProgress = this.createPersistentNotice("🔄 正在刷新云端列表...");
			await this.renderCloudList();
			refreshProgress.complete(`✅ ${fileName} 上传完成，云端列表已更新`);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : '未知错误';
			uploadProgress.fail(`❌ 上传失败: ${errorMsg}`);
			console.error('Upload error:', error);
		}
	}

	/**
	 * 切换片段启用状态的统一方法
	 * @param fileName 文件名
	 * @param customMessage 自定义通知消息
	 * @param silent 是否静默执行（不显示通知）
	 */
	async toggleSnippetWithCache(fileName: string, customMessage?: { enabled: string, disabled: string }, silent: boolean = false) {
		try {
			const wasEnabled = this.plugin.localManager.isSnippetEnabled(fileName);
			console.log(`[CSS Snippets Manager] Toggling ${fileName}: was ${wasEnabled ? 'enabled' : 'disabled'}`);
			
			const result = await this.plugin.localManager.toggleSnippet(fileName);
			
			if (result) {
				// Invalidate local cache since snippet status changed
				this.plugin.invalidateLocalCache();
				
				const isNowEnabled = !wasEnabled;
				console.log(`[CSS Snippets Manager] Toggle successful: ${fileName} is now ${isNowEnabled ? 'enabled' : 'disabled'}`);
				
				if (!silent) {
					if (customMessage) {
						new Notice(wasEnabled ? customMessage.disabled : customMessage.enabled);
					} else {
						new Notice(`✅ ${fileName} 状态已切换`);
					}
				}
				
				return { success: true, wasEnabled, isEnabled: isNowEnabled };
			} else {
				console.warn(`[CSS Snippets Manager] Toggle failed for ${fileName}`);
				if (!silent) {
					this.plugin.showErrorNotice('切换状态', new Error(`无法切换 ${fileName} 的状态`));
				}
				return { success: false, wasEnabled, isEnabled: wasEnabled };
			}
		} catch (error) {
			console.error('[CSS Snippets Manager] Toggle error:', error);
			if (!silent) {
				this.plugin.showErrorNotice('切换状态', error);
			}
			throw error;
		}
	}

	async toggleSnippet(fileName: string) {
		const result = await this.toggleSnippetWithCache(fileName);
		if (result.success) {
			// 统一使用renderLocalList刷新，避免重复渲染逻辑
			await this.renderLocalList({
				searchQuery: this.isSearchActive ? this.searchQuery : '',
				showProgress: false,
				operation: '状态切换'
			});
		}
	}

	async refreshLists() {
		try {
			// Refresh local snippets list
			await this.renderLocalList();
			
			// 添加小延迟避免同时渲染冲突
			await new Promise(resolve => setTimeout(resolve, 50));
			
			// Refresh cloud snippets list
			await this.renderCloudList();
			
			// 使用统一的列表更新通知
			this.showListUpdateNotice('both', '刷新');
		} catch (error) {
			console.error('Error refreshing lists:', error);
			this.plugin.showErrorNotice('刷新', error);
		}
	}

	// 静默刷新所有列表（打开面板时使用）
	async refreshListsSilently() {
		try {
			await this.renderLocalList();
			// 添加小延迟避免同时渲染冲突
			await new Promise(resolve => setTimeout(resolve, 50));
			await this.renderCloudList();
		} catch (error) {
			console.error('Error refreshing lists silently:', error);
		}
	}

	// 🚀 新的统一列表管理系统
	
	// 📋 本地列表管理器 - 统一的本地片段显示和搜索
	async renderLocalList(options: {
		searchQuery?: string;
		showProgress?: boolean;
		operation?: string;
	} = {}): Promise<void> {
		// 防止重复渲染
		if (this.isRenderingLocal) {
			console.log('本地列表正在渲染中，跳过重复渲染');
			return;
		}
		
		const { searchQuery = '', showProgress = false, operation } = options;
		const localListDiv = this.containerEl.querySelector('.css-snippets-local-list') as HTMLElement;
		if (!localListDiv) return;

		this.isRenderingLocal = true; // 设置渲染状态
		try {
			// 注释掉刷新提示，让操作更流畅
			// if (showProgress) {
			//     new Notice(`🔄 正在刷新本地列表...`);
			// }

			// 清空现有列表
			localListDiv.empty();

			// 获取本地片段数据
			const snippets = await this.plugin.localManager.getSnippetsList();
			
			// 应用搜索过滤
			let filteredSnippets = snippets;
			const isSearching = searchQuery.trim().length > 0;
			
			if (isSearching) {
				filteredSnippets = snippets.filter(snippet => {
					const name = snippet.name.toLowerCase();
					const desc = this.plugin.settings.snippetDescriptions[snippet.name]?.toLowerCase() || '';
					const searchTerm = searchQuery.toLowerCase();
					return name.includes(searchTerm) || desc.includes(searchTerm);
				});
			}

			// 应用排序
			const sortedSnippets = this.sortLocalSnippets(filteredSnippets);

			// 更新搜索信息显示
			if (isSearching) {
				this.updateLocalSearchInfo(searchQuery, sortedSnippets.length);
			} else {
				this.updateLocalSearchInfo("", sortedSnippets.length, false);
			}

			// 渲染列表
			if (sortedSnippets.length === 0) {
				const emptyText = isSearching 
					? '没有找到匹配的本地片段' 
					: '没有找到本地 CSS 片段';
				localListDiv.createEl('p', { text: emptyText, cls: 'css-snippets-empty' });
				return;
			}

			// 渲染每个片段项
			for (const snippet of sortedSnippets) {
				this.renderLocalSnippetItem(localListDiv, snippet);
			}

			// 操作完成提示
			if (operation && showProgress) {
				this.showListUpdateNotice('local', operation);
			}

		} catch (error) {
			console.error('❌ 本地列表渲染失败:', error);
			localListDiv.createEl('p', { 
				text: `加载失败: ${error instanceof Error ? error.message : '未知错误'}`, 
				cls: 'css-snippets-error' 
			});
			
			if (operation) {
				this.plugin.showErrorNotice(operation, error);
			}
		} finally {
			this.isRenderingLocal = false; // 重置渲染状态
		}
	}

	// 📋 云端列表管理器 - 统一的云端文件显示和搜索
	async renderCloudList(options: {
		searchQuery?: string;
		showProgress?: boolean;
		operation?: string;
	} = {}): Promise<void> {
		// 防止重复渲染
		if (this.isRenderingCloud) {
			console.log('云端列表正在渲染中，跳过重复渲染');
			return;
		}
		
		const { searchQuery = '', showProgress = false, operation } = options;
		const cloudListDiv = this.containerEl.querySelector('.css-snippets-cloud-list') as HTMLElement;
		if (!cloudListDiv) return;

		this.isRenderingCloud = true; // 设置渲染状态
		try {
			if (showProgress) {
				new Notice(`🔄 正在刷新云端列表...`);
			}

			// 清空现有列表
			cloudListDiv.empty();

			// 检查GitHub配置
			if (!this.plugin.settings.githubToken || !this.plugin.settings.githubRepoUrl) {
				cloudListDiv.createEl('p', { text: '请在设置中配置 GitHub 仓库', cls: 'css-snippets-notice' });
				this.updateCloudSearchInfo("", 0, false);
				return;
			}

			// 获取云端文件数据
			const files = await this.plugin.getRealtimeCloudFiles();
			
			// 应用搜索过滤
			let filteredFiles = files;
			const isSearching = searchQuery.trim().length > 0;
			
			if (isSearching) {
				filteredFiles = files.filter(file => {
					const name = file.name.toLowerCase();
					const desc = this.plugin.settings.snippetDescriptions[file.name]?.toLowerCase() || '';
					const searchTerm = searchQuery.toLowerCase();
					return name.includes(searchTerm) || desc.includes(searchTerm);
				});
			}

			// 应用排序
			const sortedFiles = this.sortCloudFiles(filteredFiles);

			// 更新搜索信息显示
			if (isSearching) {
				this.updateCloudSearchInfo(searchQuery, sortedFiles.length);
			} else {
				this.updateCloudSearchInfo("", sortedFiles.length, false);
			}

			// 渲染列表
			if (sortedFiles.length === 0) {
				const emptyText = isSearching 
					? '没有找到匹配的云端片段' 
					: '同步或增量同步后，请等待片刻刷新列表';
					// : '仓库中没有CSS文件';
				cloudListDiv.createEl('p', { text: emptyText, cls: 'css-snippets-empty' });
				return;
			}

			// 渲染每个文件项
			for (const file of sortedFiles) {
				this.renderCloudFileItem(cloudListDiv, file);
			}

			// 操作完成提示
			if (operation && showProgress) {
				this.showListUpdateNotice('cloud', operation);
			}

		} catch (error) {
			console.error('❌ 云端列表渲染失败:', error);
			cloudListDiv.createEl('p', { 
				text: `加载失败: ${error instanceof Error ? error.message : '未知错误'}`, 
				cls: 'css-snippets-error' 
			});
			
			if (operation) {
				this.plugin.showErrorNotice(operation, error);
			}
		} finally {
			this.isRenderingCloud = false; // 重置渲染状态
		}
	}

	// 🔧 渲染单个本地片段项
	private renderLocalSnippetItem(container: HTMLElement, snippet: LocalSnippet): void {
		const itemDiv = container.createEl('div', { 
			cls: `css-snippets-item ${snippet.enabled ? 'enabled-item' : 'disabled-item'}`
		});
		
		// Snippet name and status
		const headerDiv = itemDiv.createEl('div', { cls: 'css-snippets-item-header' });
		headerDiv.createEl('span', { 
			text: snippet.name, 
			cls: 'css-snippets-item-name' 
		});
		
		const statusSpan = headerDiv.createEl('span', { 
			text: snippet.enabled ? '✅ 已启用' : '⭕ 已禁用',
			cls: `css-snippets-status ${snippet.enabled ? 'enabled' : 'disabled'}`
		});

		// 文件信息行：修改时间和哈希值
		const infoDiv = itemDiv.createEl('div', { cls: 'css-snippets-file-info' });
		const modifiedDate = new Date(snippet.lastModified).toLocaleString('zh-CN');
		infoDiv.createEl('span', { 
			text: `修改时间: ${modifiedDate}`,
			cls: 'css-snippets-file-date'
		});
		infoDiv.createEl('span', { 
			text: `哈希: ${snippet.hash}`,
			cls: 'css-snippets-file-hash'
		});

		// Description input
		const descDiv = itemDiv.createEl('div', { cls: 'css-snippets-description' });
		const descInput = descDiv.createEl('input', {
			type: 'text',
			placeholder: '添加描述...',
			cls: 'css-snippets-desc-input'
		});
		
		// Load existing description
		const existingDescription = this.plugin.descriptionManager.getDescription(snippet.name);
		descInput.value = existingDescription;
		
		// Save description on input change
		let saveTimeout: NodeJS.Timeout;
		descInput.addEventListener('input', () => {
			clearTimeout(saveTimeout);
			saveTimeout = setTimeout(async () => {
				try {
					await this.plugin.descriptionManager.setDescription(snippet.name, descInput.value);
				} catch (error) {
					console.error('Error saving description:', error);
				}
			}, 1000); // 延迟1秒保存，避免频繁保存
		});

		// Action buttons
		const actionsDiv = itemDiv.createEl('div', { cls: 'css-snippets-actions' });

		// Toggle enabled
		const toggleBtn = this.createButton(actionsDiv, snippet.enabled ? '禁用' : '启用', 'css-snippets-btn');
		toggleBtn.onclick = async () => {
			try {
				await this.plugin.localManager.toggleSnippet(snippet.name);
				// 刷新显示
				await this.renderLocalList({ 
					searchQuery: this.isSearchActive ? this.searchQuery : '',
					operation: snippet.enabled ? '禁用片段' : '启用片段'
				});
			} catch (error) {
				this.plugin.showErrorNotice('切换状态', error);
			}
		};

		// Edit snippet
		const editBtn = this.createButton(actionsDiv, '编辑', 'css-snippets-btn');
		editBtn.onclick = async () => {
			try {
				await this.plugin.localManager.openInEditor(snippet.name);
			} catch (error) {
				this.plugin.showErrorNotice('打开编辑器', error);
			}
		};

		// Sync to cloud (使用增量同步方式)
		const syncBtn = this.createButton(actionsDiv, '同步', 'css-snippets-btn');
		syncBtn.onclick = async () => {
			if (!this.plugin.settings.githubToken || !this.plugin.settings.githubRepoUrl) {
				this.plugin.requireGitHubConfig();
				return;
			}
			
			// 使用统一的持续通知管理
			const syncProgress = this.createPersistentNotice(`🔄 正在同步 ${snippet.name}...`);
			try {
				// 使用增量同步系统，只同步当前文件
				const result = await this.plugin.performSafeSync('toCloud', { 
					selectedFiles: [snippet.name],
					useSecureHash: true 
				});
				
				if (result.success) {
					const details = result.details;
					let message = `✅ ${snippet.name} 同步成功`;
					
					if (details?.uploaded?.includes(snippet.name)) {
						message += '（新增）';
					} else if (details?.updated?.includes(snippet.name)) {
						message += '（更新）';
					} else if (details?.skipped?.includes(snippet.name)) {
						message += '（内容相同，已跳过）';
					}
					
					// 刷新云端列表并使用统一的通知
					syncProgress.hide();
					const refreshProgress = this.createPersistentNotice("🔄 正在刷新云端列表...");
					await this.renderCloudList();
					refreshProgress.complete(`✅ ${snippet.name} 同步完成，云端列表已更新`);
				} else if (result.conflicts && result.conflicts.includes(snippet.name)) {
					// 有冲突时询问是否覆盖
					const overwrite = confirm(`${snippet.name} 在云端内容不同，是否覆盖云端文件？`);
					
					if (overwrite) {
						syncProgress.hide();
						const overwriteProgress = this.createPersistentNotice(`🔄 正在覆盖云端的 ${snippet.name}...`);
						const overwriteResult = await this.plugin.performSafeSync('toCloud', { 
							selectedFiles: [snippet.name],
							forceOverwrite: true,
							useSecureHash: true 
						});
						
						if (overwriteResult.success) {
							// 刷新云端列表并使用统一的通知
							overwriteProgress.hide();
							const refreshProgress = this.createPersistentNotice("🔄 正在刷新云端列表...");
							await this.renderCloudList();
							refreshProgress.complete(`✅ ${snippet.name} 覆盖同步完成，云端列表已更新`);
						} else {
							overwriteProgress.fail(`❌ 覆盖失败：${overwriteResult.message || '请检查网络连接'}`);
						}
					} else {
						syncProgress.fail(`⚠️ ${snippet.name} 同步已取消：存在文件冲突`);
					}
				} else {
					syncProgress.fail(`❌ 同步失败：${result.message || '请检查网络连接和GitHub设置'}`);
				}
			} catch (error) {
				syncProgress.fail(`❌ 同步失败: ${error instanceof Error ? error.message : '未知错误'}`);
				console.error('Sync error:', error);
			}
		};

		// Delete snippet
		const deleteBtn = this.createButtonWithClasses(actionsDiv, '删除', 
			['css-snippets-btn', 'css-snippets-btn-danger']);
		deleteBtn.onclick = () => {
			// 保存当前活动元素的焦点
			const activeElement = document.activeElement as HTMLElement;
			
			// 显示模态确认窗口
			this.showDeleteConfirmModal(snippet.name, async () => {
				try {
					await this.plugin.localManager.deleteSnippet(snippet.name);
					this.showFileOperationNotice('删除', snippet.name);
					
					// 刷新本地列表
					await this.renderLocalList({ 
						searchQuery: this.isSearchActive ? this.searchQuery : '',
						operation: '删除本地片段'
					});
					
					// 恢复焦点
					setTimeout(() => {
						if (activeElement && activeElement.isConnected) {
							activeElement.focus();
						} else {
							const searchInput = this.containerEl.querySelector('.css-snippets-search-input') as HTMLInputElement;
							if (searchInput) searchInput.focus();
						}
					}, 100);
				} catch (error) {
					this.plugin.showErrorNotice('删除', error);
					// 恢复焦点
					setTimeout(() => {
						if (activeElement && activeElement.isConnected) {
							activeElement.focus();
						}
					}, 100);
				}
			});
		};
	}

	// 🔧 渲染单个云端文件项
	private renderCloudFileItem(container: HTMLElement, file: GitHubFile): void {
		const itemDiv = container.createEl('div', { cls: 'css-snippets-item' });
		
		// File name
		const headerDiv = itemDiv.createEl('div', { cls: 'css-snippets-item-header' });
		headerDiv.createEl('span', { 
			text: file.name, 
			cls: 'css-snippets-item-name' 
		});
		
		headerDiv.createEl('span', { 
			text: `${(file.size / 1024).toFixed(1)} KB`,
			cls: 'css-snippets-file-size'
		});

		// 文件信息行：修改时间和SHA值
		const infoDiv = itemDiv.createEl('div', { cls: 'css-snippets-file-info' });
		if (file.lastModified && file.lastModified !== 'Unknown') {
			const modifiedDate = new Date(file.lastModified).toLocaleString('zh-CN');
			infoDiv.createEl('span', { 
				text: `修改时间: ${modifiedDate}`,
				cls: 'css-snippets-file-date'
			});
		}
		
		// 计算内容哈希值（异步显示）
		const hashSpan = infoDiv.createEl('span', { 
			text: `哈希: 计算中...`,
			cls: 'css-snippets-file-sha'
		});
		
		// 异步获取内容哈希
		this.getCloudFileContentHash(file).then(contentHash => {
			hashSpan.textContent = `哈希: ${contentHash}`;
		}).catch(() => {
			hashSpan.textContent = `哈希: ${file.sha.substring(0, 8)}`;
		});

		// 描述显示区域（只读）
		const description = this.plugin.descriptionManager.getDescription(file.name);
		if (description) {
			const descDiv = itemDiv.createEl('div', {
				cls: 'css-snippets-description-readonly',
				text: description
			});
		}

		// Action buttons
		const actionsDiv = itemDiv.createEl('div', { cls: 'css-snippets-actions' });

		// Download button
		const downloadBtn = this.createButtonWithClasses(actionsDiv, '下载', 
			['css-snippets-btn', 'css-snippets-btn-primary']);
		downloadBtn.onclick = async () => {
			await this.downloadSnippet(file.name);
		};

		// Delete button
		const deleteBtn = this.createButtonWithClasses(actionsDiv, '删除', 
			['css-snippets-btn', 'css-snippets-btn-danger']);
		deleteBtn.onclick = (event) => {
			// 🔧 使用模态窗口确认删除，避免焦点问题
			event.preventDefault();
			event.stopPropagation();
			
			// 保存当前活动元素的焦点
			const activeElement = document.activeElement as HTMLElement;
			
			// 显示模态确认窗口
			this.showDeleteConfirmModal(file.name, () => {
				// 执行删除操作
				this.plugin.githubClient.deleteFile(file.path)
					.then(async () => {
						// 创建删除进度提示
					const deleteNotice = this.createPersistentNotice(`🔄 正在删除 ${file.name}...`);
					
					// 等待GitHub API处理
					await new Promise(resolve => setTimeout(resolve, 1500));
					
					deleteNotice.hide();
					this.showFileOperationNotice('delete', file.name, 'action_completed');						// 🚀 强制更新同步时间戳以确保立即同步
						this.plugin.lastCloudSync = 0;
						
						// 自动同步GitHub仓库信息
						await this.autoSyncCloudData();
						
						// 恢复焦点到之前的元素或搜索框
						setTimeout(() => {
							if (activeElement && activeElement.isConnected) {
								activeElement.focus();
							} else {
								const searchInput = this.containerEl.querySelector('.css-snippets-search-input') as HTMLInputElement;
								if (searchInput) searchInput.focus();
							}
						}, 100);
					})
					.catch((error) => {
						console.error('Delete error:', error);
						this.plugin.showErrorNotice('删除', error);
						// 恢复焦点
						setTimeout(() => {
							if (activeElement && activeElement.isConnected) {
								activeElement.focus();
							}
						}, 100);
					});
			});
		};
	}

	// 对本地片段列表进行排序
	private sortLocalSnippets(snippets: LocalSnippet[]): LocalSnippet[] {
		return snippets.sort((a, b) => {
			if (this.localSortBy === 'time') {
				// 按修改时间排序 (最新的在前)
				return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
			} else {
				// 按文件名排序 (字母顺序)
				return a.name.localeCompare(b.name);
			}
		});
	}

	// 对云端文件列表进行排序
	private sortCloudFiles(files: GitHubFile[]): GitHubFile[] {
		return files.sort((a, b) => {
			if (this.cloudSortBy === 'time') {
				// 按修改时间排序 (最新的在前)
				const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
				const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
				return timeB - timeA;
			} else {
				// 按文件名排序 (字母顺序)
				return a.name.localeCompare(b.name);
			}
		});
	}

	// 📊 获取云端文件的内容哈希值（直接使用SyncManager确保与增量同步一致）
	async getCloudFileContentHash(file: GitHubFile): Promise<string> {
		try {
			// 直接使用SyncManager的哈希计算方法，确保与增量同步完全一致
			return await this.plugin.syncManager.getCloudFileContentHash(file, false);
		} catch (error) {
			console.error(`计算云端文件 ${file.name} 哈希失败:`, error);
			// 发生错误时，返回Git SHA的前8位作为备用显示
			return file.sha.substring(0, 8);
		}
	}

	// � 刷新云端文件列表（统一入口）

	// � 带重试机制的云端列表刷新（用于删除操作后确保文件确实消失）
	// 🚀 刷新云端文件列表（统一入口）
	async refreshCloudList(): Promise<void> {
		try {
			await this.renderCloudList();
		} catch (error) {
			console.error('Failed to refresh cloud list:', error);
			this.plugin.showErrorNotice('刷新云端列表', error);
		}
	}

	// 🚀 刷新本地文件列表（统一入口）
	async refreshLocalList(): Promise<void> {
		try {
			await this.renderLocalList();
		} catch (error) {
			console.error('Failed to refresh local list:', error);
			this.plugin.showErrorNotice('刷新本地列表', error);
		}
	}

	// 🔧 新增：显示删除确认模态窗口
	showDeleteConfirmModal(fileName: string, onConfirm: () => void): void {
		// 创建模态窗口遮罩层
		const overlay = document.createElement('div');
		overlay.className = 'css-snippets-modal-overlay';
		
		// 创建模态窗口
		const modal = document.createElement('div');
		modal.className = 'css-snippets-modal';
		
		// 直接显示删除提示（无标题）
		const content = document.createElement('p');
		content.className = 'css-snippets-modal-content css-snippets-modal-main-text';
		content.textContent = `删除"${fileName}"？`;
		
		// 按钮组
		const buttons = document.createElement('div');
		buttons.className = 'css-snippets-modal-buttons';
		
		// 取消按钮
		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'css-snippets-modal-btn css-snippets-modal-btn-cancel';
		cancelBtn.textContent = '取消';
		
		// 确认按钮
		const confirmBtn = document.createElement('button');
		confirmBtn.className = 'css-snippets-modal-btn css-snippets-modal-btn-confirm';
		confirmBtn.textContent = '删除';
		
		// 组装模态窗口
		buttons.appendChild(cancelBtn);
		buttons.appendChild(confirmBtn);
		modal.appendChild(content);
		modal.appendChild(buttons);
		overlay.appendChild(modal);
		
		// 添加到页面
		document.body.appendChild(overlay);
		
		// 关闭模态窗口的函数
		const closeModal = () => {
			overlay.classList.add('closing');
			setTimeout(() => {
				if (document.body.contains(overlay)) {
					document.body.removeChild(overlay);
				}
			}, 150);
		};
		
		// 事件监听
		cancelBtn.onclick = closeModal;
		confirmBtn.onclick = () => {
			closeModal();
			onConfirm();
		};
		
		// 点击遮罩层关闭
		overlay.onclick = (e) => {
			if (e.target === overlay) {
				closeModal();
			}
		};
		
		// ESC键关闭
		const escapeHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				closeModal();
				document.removeEventListener('keydown', escapeHandler);
			}
		};
		document.addEventListener('keydown', escapeHandler);
		
		// 聚焦到确认按钮，但不影响其他输入框
		setTimeout(() => {
			confirmBtn.focus();
		}, 100);
	}

	// 临时禁用指定模块的所有输入框，防止在操作期间产生冲突
	temporarilyDisableInputs(module: 'cloud' | 'local') {
		try {
			const tabSelector = `[data-tab="${module}"]`;
			const tab = this.containerEl.querySelector(tabSelector);
			if (tab) {
				// 禁用搜索输入框 - 只使用disabled属性，避免使用pointer-events
				const searchInput = tab.querySelector('.css-snippets-search-input') as HTMLInputElement;
				if (searchInput) {
					searchInput.disabled = true;
					searchInput.classList.add('css-snippets-input-disabled');
				}
				
				// 禁用所有描述输入框
				const descInputs = tab.querySelectorAll('.css-snippets-desc-input') as NodeListOf<HTMLInputElement>;
				descInputs.forEach(input => {
					input.disabled = true;
					input.classList.add('css-snippets-input-disabled');
				});
				
				// 禁用所有按钮
				const buttons = tab.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
				buttons.forEach(button => {
					button.disabled = true;
					button.classList.add('css-snippets-btn-disabled');
				});
			}
		} catch (error) {
			console.error(`Error disabling inputs for ${module}:`, error);
		}
	}

	// 恢复指定模块的输入框状态并设置焦点
	restoreInputsAndFocus(module: 'cloud' | 'local', searchValue: string = '') {
		try {
			const tabSelector = `[data-tab="${module}"]`;
			const tab = this.containerEl.querySelector(tabSelector);
			if (tab) {
				// 恢复搜索输入框 - 移除CSS样式操作，只使用disabled属性和CSS类
				const searchInput = tab.querySelector('.css-snippets-search-input') as HTMLInputElement;
				if (searchInput) {
					searchInput.disabled = false;
					searchInput.classList.remove('css-snippets-input-disabled');
					// 恢复搜索值
					if (searchValue && searchInput.value !== searchValue) {
						searchInput.value = searchValue;
					}
				}
				
				// 恢复所有描述输入框
				const descInputs = tab.querySelectorAll('.css-snippets-desc-input') as NodeListOf<HTMLInputElement>;
				descInputs.forEach(input => {
					input.disabled = false;
					input.classList.remove('css-snippets-input-disabled');
				});
				
				// 恢复所有按钮
				const buttons = tab.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
				buttons.forEach(button => {
					button.disabled = false;
					button.classList.remove('css-snippets-btn-disabled');
				});
				
				// 🔧 修复：移除延迟焦点设置，避免与其他操作冲突
				// 让用户自然地点击或聚焦输入框，不强制设置焦点
				console.log(`[CSS Snippets Manager] 已恢复 ${module} 模块的输入状态`);
			}
		} catch (error) {
			console.error(`Error restoring inputs for ${module}:`, error);
		}
	}

	// 恢复云端搜索输入框的焦点和可用状态 (保留向后兼容)
	restoreCloudSearchInputFocus() {
		this.restoreInputsAndFocus('cloud', this.searchQuery);
	}

	// 恢复本地搜索输入框的焦点和可用状态 (保留向后兼容)
	restoreLocalSearchInputFocus() {
		this.restoreInputsAndFocus('local', this.searchQuery);
	}

	formatCSS(css: string): string {
		// Simple CSS formatting function
		try {
			// Remove extra whitespaces and format basic structure
			let formatted = css
				.replace(/\s*{\s*/g, ' {\n  ')    // Format opening braces
				.replace(/;\s*/g, ';\n  ')        // Format semicolons
				.replace(/\s*}\s*/g, '\n}\n')     // Format closing braces
				.replace(/,\s*/g, ',\n')          // Format commas in selectors
				.replace(/\n\s*\n/g, '\n')        // Remove extra empty lines
				.trim();
			
			// Clean up extra indentation
			const lines = formatted.split('\n');
			let indentLevel = 0;
			const formattedLines = lines.map(line => {
				const trimmed = line.trim();
				if (!trimmed) return '';
				
				if (trimmed.includes('}')) {
					indentLevel = Math.max(0, indentLevel - 1);
				}
				
				const indentedLine = '  '.repeat(indentLevel) + trimmed;
				
				if (trimmed.includes('{')) {
					indentLevel++;
				}
				
				return indentedLine;
			});
			
			return formattedLines.join('\n');
		} catch (error) {
			console.error('CSS formatting error:', error);
			return css; // Return original if formatting fails
		}
	}

	// Scope CSS to prevent global interference
	private scopeCSS(css: string, scopeSelector: string): string {
		// Simple CSS scoping implementation
		// This method prepends the scope selector to all CSS rules
		
		// Parse CSS and add scope to each rule
		const lines = css.split('\n');
		const scopedLines: string[] = [];
		let insideRule = false;
		let currentRule = '';
		
		for (const line of lines) {
			const trimmed = line.trim();
			
			// Skip empty lines and comments
			if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.endsWith('*/')) {
				scopedLines.push(line);
				continue;
			}
			
			// Check if this line contains a selector (doesn't start with a property)
			if (!insideRule && trimmed.includes('{')) {
				// This is a selector line
				const selectorPart = trimmed.substring(0, trimmed.indexOf('{'));
				const restPart = trimmed.substring(trimmed.indexOf('{'));
				
				// Add scope to selector, but avoid scoping :root, @media, @keyframes, etc.
				if (!selectorPart.trim().startsWith(':root') && 
					!selectorPart.trim().startsWith('@') && 
					!selectorPart.trim().startsWith('*') &&
					selectorPart.trim() !== '') {
					
					// Split multiple selectors and scope each one
					const selectors = selectorPart.split(',').map(s => {
						const trimmedSelector = s.trim();
						// Don't scope if it already starts with the scope selector
						if (trimmedSelector.startsWith(scopeSelector)) {
							return trimmedSelector;
						}
						return `${scopeSelector} ${trimmedSelector}`;
					});
					
					scopedLines.push(`${selectors.join(', ')}${restPart}`);
				} else {
					// Keep special selectors as-is
					scopedLines.push(line);
				}
				
				if (restPart.includes('}')) {
					insideRule = false;
				} else {
					insideRule = true;
				}
			} else {
				// Inside a rule or property line
				scopedLines.push(line);
				if (trimmed.includes('}')) {
					insideRule = false;
				}
			}
		}
		
		return scopedLines.join('\n');
	}

	// Check for CSS rules that might globally interfere with input elements
	private containsGloballyDangerousCSS(css: string): boolean {
		// Patterns that might interfere with input functionality
		const dangerousPatterns = [
			/\binput\s*\{[^}]*pointer-events\s*:\s*none/i,
			/\binput\s*\{[^}]*user-select\s*:\s*none/i,
			/\binput\s*\{[^}]*cursor\s*:\s*none/i,
			/\*\s*\{[^}]*pointer-events\s*:\s*none/i,
			/\*\s*\{[^}]*user-select\s*:\s*none/i,
			/^input\s*[,{]/m,  // Global input selector without prefix
			/^\s*\*\s*\{/m     // Universal selector
		];
		
		return dangerousPatterns.some(pattern => pattern.test(css));
	}

	// � 新增：显示删除确认模态窗口
	// 显示删除确认模态窗口

}

// Settings Tab
class CSSSnippetsManagerSettingTab extends PluginSettingTab {
	plugin: CSSSnippetsManagerPlugin;

	constructor(app: App, plugin: CSSSnippetsManagerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'CSS Snippets Manager 设置' });

		// GitHub Repository Settings Section
		containerEl.createEl('h3', { text: '链接设置' });

		// GitHub Repository URL
		const urlSetting = new Setting(containerEl)
			.setName('GitHub 仓库 URL')
			.setDesc('输入您的 GitHub 仓库链接')
			.addText(text => text
				.setPlaceholder('username/css-snippets')
				.setValue(this.plugin.settings.githubRepoUrl)
				.onChange(async (value) => {
					this.plugin.settings.githubRepoUrl = value;
					await this.plugin.saveSettings();
				}));
		
		// 为URL输入框添加自定义类
		urlSetting.settingEl.addClass('css-snippets-url-setting');
		urlSetting.settingEl.addClass('css-snippets-github-setting-item');

		// GitHub Token
		let tokenVisible = false;
		let tokenInput: HTMLInputElement;
		let toggleButton: HTMLElement;
		const tokenSetting = new Setting(containerEl)
			.setName('GitHub Token')
			.setDesc('输入您的 GitHub Token')
			.addText(text => {
				text.setPlaceholder('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
					.setValue(this.plugin.settings.githubToken)
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value;
						await this.plugin.saveSettings();
					});
				
				// Set initial type to password (hidden)
				text.inputEl.type = 'password';
				tokenInput = text.inputEl; // 保存引用
				
				return text;
			});
		
		// 在token输入框后添加显示/隐藏按钮
		const tokenSettingEl = tokenSetting.settingEl;
		tokenSettingEl.addClass('css-snippets-token-setting');
		tokenSettingEl.addClass('css-snippets-github-setting-item');
		const tokenControlEl = tokenSettingEl.querySelector('.setting-item-control') as HTMLElement;
		if (tokenControlEl) {
			toggleButton = tokenControlEl.createEl('button', {
				cls: 'clickable-icon setting-editor-extra-setting-button',
				attr: { 'aria-label': '显示/隐藏 Token' }
			});
			
			// 创建眼睛图标
			const eyeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			eyeIcon.setAttribute('width', '16');
			eyeIcon.setAttribute('height', '16');
			eyeIcon.setAttribute('viewBox', '0 0 24 24');
			eyeIcon.setAttribute('fill', 'none');
			eyeIcon.setAttribute('stroke', 'currentColor');
			eyeIcon.setAttribute('stroke-width', '2');
			eyeIcon.setAttribute('stroke-linecap', 'round');
			eyeIcon.setAttribute('stroke-linejoin', 'round');
			
			// 初始为隐藏状态 (eye-off)
			eyeIcon.innerHTML = '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line>';
			
			toggleButton.appendChild(eyeIcon);
			
			toggleButton.onclick = () => {
				tokenVisible = !tokenVisible;
				if (tokenInput) {
					tokenInput.type = tokenVisible ? 'text' : 'password';
					// 更新图标
					if (tokenVisible) {
						// 显示状态 (eye)
						eyeIcon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
					} else {
						// 隐藏状态 (eye-off)
						eyeIcon.innerHTML = '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line>';
					}
				}
			};
		}

		// GitHub Token 获取步骤说明
		const tokenGuideEl = containerEl.createEl('div', { cls: 'css-snippets-token-guide' });
		tokenGuideEl.innerHTML = `
			<details class="css-snippets-collapsible">
				<summary class="css-snippets-summary">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="css-snippets-chevron">
						<polyline points="6,9 12,15 18,9"></polyline>
					</svg>
					获取 GitHub Token
				</summary>
				<div class="css-snippets-content">
					<ol>
						<li>登录 <a href="https://github.com" target="_blank">GitHub</a></li>
						<li>点击右上角头像 → Settings</li>
						<li>左侧菜单选择 Developer settings</li>
						<li>选择 Personal access tokens → Tokens (classic)</li>
						<li>点击 Generate new token → Generate new token (classic)</li>
						<li>填写 Note，设置 Expiration，勾选 <strong>repo</strong> 权限</li>
						<li>点击 Generate token，复制生成的 Token</li>
					</ol>
					<p><strong>注意：</strong>Token 只显示一次，请妥善保存</p>
				</div>
			</details>
		`;

		// Connection Test Button
		const testSetting = new Setting(containerEl)
			.setName('连接测试')
			.setDesc('测试 GitHub 仓库连接')
			.addButton(button => button
				.setButtonText('测试连接')
				.setClass('css-snippets-test-btn')
				.onClick(async () => {
					const { githubRepoUrl, githubToken } = this.plugin.settings;
					if (!githubRepoUrl || !githubToken) {
						new Notice('请先填写仓库 URL 和 Token');
						return;
					}
					
					// Validate and convert GitHub URL to owner/repo format
					const validation = SecurityUtils.validateGitHubRepoUrl(githubRepoUrl);
					if (!validation.valid) {
						this.plugin.showErrorNotice('仓库URL验证', new Error(validation.message));
						return;
					}
					
					const repoPath = `${validation.owner}/${validation.repo}`;
					
					// Update GitHub client credentials with proper format
					this.plugin.githubClient.updateCredentials(githubToken, repoPath);
					
					new Notice('🔍 正在测试连接...');
					
					try {
						// 首先测试基本的GitHub API连接
						console.log('🔍 开始连接测试...');
						console.log('📋 仓库路径:', repoPath);
						console.log('🔑 Token长度:', githubToken.length);
						
						const isAuthenticated = await this.plugin.githubClient.authenticate();
						console.log('🔐 认证结果:', isAuthenticated);
						
						if (isAuthenticated) {
							new Notice('✅ GitHub 认证成功！');
							
							// Try to fetch files to verify repository access
							try {
								console.log('📁 正在获取仓库文件列表...');
								const files = await this.plugin.githubClient.listFiles();
								console.log('📄 找到文件数量:', files.length);
								
								new Notice(`✅ 连接成功！找到 ${files.length} 个 CSS 文件`);
								
								// Update repo info
								this.plugin.settings.repoInfo = {
									name: githubRepoUrl,
									lastSync: Date.now(),
									totalFiles: files.length
								};
								await this.plugin.saveSettings();
								this.display(); // Refresh to show updated info
							} catch (repoError) {
								console.error('📁 仓库访问失败:', repoError);
								const errorMsg = repoError instanceof Error ? repoError.message : '未知错误';
								new Notice(`⚠️ 认证成功但无法访问仓库: ${errorMsg}`);
								new Notice('请检查仓库 URL 是否正确，以及 Token 是否有仓库访问权限');
							}
						} else {
							console.error('🔐 GitHub 认证失败');
							new Notice('❌ GitHub 认证失败，请检查 Token 是否正确');
							new Notice('💡 提示：请确保 Token 具有 repo 权限');
						}
					} catch (error) {
						console.error('🌐 连接测试异常:', error);
						const errorMsg = error instanceof Error ? error.message : '未知错误';
						
						// 提供更详细的错误诊断
						if (errorMsg.includes('fetch')) {
							new Notice('❌ 网络连接失败，请检查网络连接和防火墙设置');
						} else if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
							new Notice('❌ 请求超时，请检查网络连接稳定性');
						} else if (errorMsg.includes('401')) {
							new Notice('❌ Token 认证失败，请检查 Token 是否正确和有效');
						} else if (errorMsg.includes('404')) {
							new Notice('❌ 仓库不存在或无访问权限，请检查仓库 URL');
						} else {
							new Notice(`❌ 连接失败: ${errorMsg}`);
						}
					}
				}));
		
		// 为连接测试添加CSS类
		testSetting.settingEl.addClass('css-snippets-github-setting-item');

		// Repository Information Display
		if (this.plugin.settings.repoInfo) {
			const repoInfo = this.plugin.settings.repoInfo;
			const repoInfoSetting = new Setting(containerEl)
				.setName('仓库信息')
				.setDesc(`📁 ${repoInfo.name} | 📄 ${repoInfo.totalFiles} 个文件 | 🕒 最后同步: ${new Date(repoInfo.lastSync).toLocaleString()}`)
				.addButton(button => button
					.setButtonText('刷新信息')
					.onClick(async () => {
						try {
							const files = await this.plugin.githubClient.listFiles();
							this.plugin.settings.repoInfo = {
								name: this.plugin.settings.githubRepoUrl,
								lastSync: Date.now(),
								totalFiles: files.length
							};
							await this.plugin.saveSettings();
							this.display();
							new Notice('📊 仓库信息已更新');
						} catch (error) {
							new Notice('❌ 无法获取仓库信息');
						}
					}));
			
			// 为仓库信息添加CSS类
			repoInfoSetting.settingEl.addClass('css-snippets-github-setting-item');
		}

		// Other Settings Section
		containerEl.createEl('h3', { text: '其他设置' });

		// Auto enable new snippets
		new Setting(containerEl)
			.setName('新加入本地 snippets 默认启用')
			.setDesc('设置新加入本地 snippets 目录的 CSS 片段是否默认打开')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoEnableNewSnippets)
				.onChange(async (value) => {
					this.plugin.settings.autoEnableNewSnippets = value;
					await this.plugin.saveSettings();
				}));

		// Auto open after save
		new Setting(containerEl)
			.setName('CSS 保存后自动打开编辑器')
			.setDesc('设置在 CSS 管理模板输入的自定义 CSS 片段保存后是否自动用系统默认编辑器打开')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoOpenAfterSave)
				.onChange(async (value) => {
					this.plugin.settings.autoOpenAfterSave = value;
					await this.plugin.saveSettings();
				}));

		// Icon position toggle
		new Setting(containerEl)
			.setName('图标位置')
			.setDesc('设置 CSS Snippets Manager 图标显示位置')
			.addDropdown(dropdown => dropdown
				.addOption('ribbon', '左侧菜单栏')
				.addOption('statusbar', '状态栏')
				.setValue(this.plugin.settings.iconPosition)
				.onChange(async (value: 'ribbon' | 'statusbar') => {
					this.plugin.switchIconPosition(value);
				}));

		// Cache Management - 性能优化设置
		containerEl.createEl('h3', { text: '性能优化' });
		
		new Setting(containerEl)
			.setName('清除本地缓存')
			.setDesc('清除本地snippets缓存数据，强制重新获取文件列表')
			.addButton(button => button
				.setButtonText('清除缓存')
				.onClick(() => {
					this.plugin.clearAllCaches();
					new Notice('✅ 本地缓存已清除');
				}));

		// 同步设置 - 移动到性能优化之后
		containerEl.createEl('h3', { text: '同步设置' });

		// 增量同步缓存管理
		new Setting(containerEl)
			.setName('增量同步缓存')
			.setDesc('清除增量同步的哈希缓存，下次同步时将重新计算所有文件哈希')
			.addButton(button => button
				.setButtonText('清除缓存')
				.onClick(async () => {
					try {
						this.plugin.syncManager.clearIncrementalSyncCache();
						new Notice('✅ 增量同步缓存已清除');
					} catch (error) {
						this.plugin.showErrorNotice('清除缓存', error);
					}
				}))
			.addButton(button => button
				.setButtonText('查看比较报告')
				.onClick(async () => {
					try {
						const report = await this.plugin.syncManager.getDetailedComparisonReport(false);
						console.log('📊 文件比较报告:', report);
						
						let reportText = `文件比较报告（共 ${report.length} 个文件）:\n\n`;
						for (const comparison of report.slice(0, 10)) { // 只显示前10个
							reportText += `📄 ${comparison.filename}: ${comparison.action}\n`;
							reportText += `   本地哈希: ${comparison.localHash}\n`;
							reportText += `   云端哈希: ${comparison.cloudHash}\n\n`;
						}
						
						if (report.length > 10) {
							reportText += `... 还有 ${report.length - 10} 个文件（详见控制台）`;
						}
						
						const reportEl = createEl('pre', { text: reportText });
						reportEl.style.maxHeight = '300px';
						reportEl.style.overflow = 'auto';
						reportEl.style.fontSize = '12px';
						reportEl.style.background = 'var(--background-secondary)';
						reportEl.style.padding = '10px';
						reportEl.style.borderRadius = '5px';
						reportEl.style.marginTop = '10px';
						
						const modal = document.createElement('div');
						modal.className = 'modal-container mod-dim';
						modal.onclick = () => modal.remove();
						
						const modalContent = modal.createEl('div', { cls: 'modal' });
						modalContent.onclick = (e) => e.stopPropagation();
						
						modalContent.createEl('h3', { text: '增量同步文件比较报告' });
						modalContent.appendChild(reportEl);
						
						const closeBtn = modalContent.createEl('button', { text: '关闭', cls: 'mod-cta' });
						closeBtn.onclick = () => modal.remove();
						closeBtn.style.marginTop = '10px';
						
						document.body.appendChild(modal);
						
					} catch (error) {
						new Notice('❌ 生成比较报告失败');
						console.error('生成比较报告失败:', error);
					}
				}));

		// 编码一致性测试
		new Setting(containerEl)
			.setName('测试编码一致性')
			.setDesc('测试上传到云端后下载的文件内容是否与原始文件产生相同的哈希值')
			.addButton(button => button
				.setButtonText('运行测试')
				.onClick(async () => {
					await this.plugin.testEncodingConsistency();
				}));

		// 网络诊断工具
		new Setting(containerEl)
			.setName('网络连接诊断')
			.setDesc('诊断GitHub API的网络连接状况和可达性')
			.addButton(button => button
				.setButtonText('诊断网络')
				.onClick(async () => {
					await this.plugin.diagnoseNetworkConnection();
				}));
	}
}
