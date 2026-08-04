import { Plugin, MarkdownView, PluginSettingTab, App, Setting, SliderComponent, TextComponent, setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';

type SpotlightShape = 'circle' | 'square';
type TrackingMode = 'cursor' | 'mouse';

interface PrivacyScreenSettings {
	spotlightWidth: number;
	spotlightHeight: number;
	horizontalOffset: number;
	blurIntensity: number;
	featherEdge: number;
	spotlightShape: SpotlightShape;
	squareRoundness: number;
	previewCursorBlink: boolean;
	wasActive: boolean;
	trackingMode: TrackingMode;
}

const DEFAULT_SETTINGS: PrivacyScreenSettings = {
	spotlightWidth: 200,
	spotlightHeight: 100,
	horizontalOffset: 0,
	blurIntensity: 8,
	featherEdge: 50,
	spotlightShape: 'circle',
	squareRoundness: 20,
	previewCursorBlink: true,
	wasActive: false,
	trackingMode: 'cursor'
};

export default class PrivacyScreenPlugin extends Plugin {
	settings: PrivacyScreenSettings;
	private overlayEl: HTMLElement | null = null;
	private isActive: boolean = false;
	private wasActiveBeforePause: boolean = false;
	private ribbonIconEl: HTMLElement | null = null;
	private pendingMouseX: number = 0;
	private pendingMouseY: number = 0;
	private mouseMoveRaf: number | null = null;

	async onload() {
		await this.loadSettings();

		// Restore state from last session, once panes exist to track a cursor in
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.wasActive) {
				this.createOverlay();
				this.isActive = true;
				this.updateRibbonState();
			}
		});

		// Add ribbon icon to toggle privacy screen
		this.ribbonIconEl = this.addRibbonIcon('eye-off', 'Toggle privacy screen', () => {
			this.toggle();
		});

		// Add command to toggle privacy screen
		this.addCommand({
			id: 'toggle',
			name: 'Toggle',
			callback: () => {
				this.toggle();
			}
		});

		// Adjustment commands
		this.addCommand({ id: 'increase-width', name: 'Increase spotlight width', callback: () => this.adjustSetting('spotlightWidth', 10, 24, 600) });
		this.addCommand({ id: 'decrease-width', name: 'Decrease spotlight width', callback: () => this.adjustSetting('spotlightWidth', -10, 24, 600) });
		this.addCommand({ id: 'increase-height', name: 'Increase spotlight height', callback: () => this.adjustSetting('spotlightHeight', 10, 24, 600) });
		this.addCommand({ id: 'decrease-height', name: 'Decrease spotlight height', callback: () => this.adjustSetting('spotlightHeight', -10, 24, 600) });
		this.addCommand({ id: 'increase-blur', name: 'Increase blur intensity', callback: () => this.adjustSetting('blurIntensity', 1, 2, 20) });
		this.addCommand({ id: 'decrease-blur', name: 'Decrease blur intensity', callback: () => this.adjustSetting('blurIntensity', -1, 2, 20) });
		this.addCommand({ id: 'increase-offset', name: 'Increase horizontal offset', callback: () => this.adjustOffset(5) });
		this.addCommand({ id: 'decrease-offset', name: 'Decrease horizontal offset', callback: () => this.adjustOffset(-5) });
		this.addCommand({ id: 'increase-feather', name: 'Increase feather edge', callback: () => this.adjustSetting('featherEdge', 5, 10, 100) });
		this.addCommand({ id: 'decrease-feather', name: 'Decrease feather edge', callback: () => this.adjustSetting('featherEdge', -5, 10, 100) });
		this.addCommand({ id: 'increase-roundness', name: 'Increase corner roundness', callback: () => this.adjustSetting('squareRoundness', 5, 0, 100) });
		this.addCommand({ id: 'decrease-roundness', name: 'Decrease corner roundness', callback: () => this.adjustSetting('squareRoundness', -5, 0, 100) });
		this.addCommand({ id: 'reset-settings', name: 'Reset to default settings', callback: () => this.resetSettings() });
		this.addCommand({ id: 'toggle-tracking-mode', name: 'Toggle tracking mode (cursor/mouse)', callback: () => this.toggleTrackingMode() });

		// Add settings tab
		this.addSettingTab(new PrivacyScreenSettingTab(this.app, this));

		// Track cursor position via various events
		this.registerDomEvent(document, 'keyup', () => this.trackCursor());
		this.registerDomEvent(document, 'click', () => this.trackCursor());
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.trackCursor())
		);

		// Mouse tracking mode - coalesce to one mask recompute per frame
		this.registerDomEvent(document, 'mousemove', (e: MouseEvent) => {
			if (!this.isActive || this.settings.trackingMode !== 'mouse') return;
			this.pendingMouseX = e.clientX;
			this.pendingMouseY = e.clientY;
			if (this.mouseMoveRaf === null) {
				this.mouseMoveRaf = requestAnimationFrame(() => {
					this.mouseMoveRaf = null;
					this.updateSpotlightPosition(this.pendingMouseX, this.pendingMouseY);
				});
			}
		});
	}

	onunload() {
		if (this.mouseMoveRaf !== null) {
			cancelAnimationFrame(this.mouseMoveRaf);
		}
		this.removeOverlay();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applySettings();
	}

	private toggle() {
		if (this.isActive) {
			this.removeOverlay();
		} else {
			this.createOverlay();
		}
		this.isActive = !this.isActive;
		this.settings.wasActive = this.isActive;
		this.updateRibbonState();
		void this.saveSettings();
	}

	private updateRibbonState() {
		if (!this.ribbonIconEl) return;
		setIcon(this.ribbonIconEl, this.isActive ? 'eye' : 'eye-off');
		this.ribbonIconEl.toggleClass('is-active', this.isActive);
		this.ribbonIconEl.setAttribute('aria-label', this.isActive ? 'Privacy screen: on' : 'Privacy screen: off');
	}

	private adjustSetting(key: 'spotlightWidth' | 'spotlightHeight' | 'blurIntensity' | 'featherEdge' | 'squareRoundness', delta: number, min: number, max: number) {
		const newValue = Math.max(min, Math.min(max, this.settings[key] + delta));
		this.settings[key] = newValue;
		if (key === 'spotlightWidth') {
			this.settings.horizontalOffset = this.clampOffsetToWidth(newValue, this.settings.horizontalOffset);
		}
		void this.saveSettings();
	}

	clampOffsetToWidth(width: number, offset: number): number {
		const maxOffset = Math.floor(width / 2) - 5;
		return Math.max(-maxOffset, Math.min(maxOffset, offset));
	}

	private adjustOffset(delta: number) {
		const maxOffset = Math.floor(this.settings.spotlightWidth / 2) - 5;
		const newValue = Math.max(-maxOffset, Math.min(maxOffset, this.settings.horizontalOffset + delta));
		this.settings.horizontalOffset = newValue;
		void this.saveSettings();
	}

	async resetSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS);
		await this.saveSettings();
	}

	private toggleTrackingMode() {
		this.settings.trackingMode = this.settings.trackingMode === 'cursor' ? 'mouse' : 'cursor';
		void this.saveSettings();
	}

	private createOverlay() {
		this.overlayEl = document.createElement('div');
		this.overlayEl.addClass('privacy-screen-overlay');
		document.body.appendChild(this.overlayEl);

		this.applySettings();
		this.trackCursor();
	}

	private currentX: number = 0;
	private currentY: number = 0;

	private applySettings() {
		if (!this.overlayEl) return;

		const { blurIntensity } = this.settings;
		this.overlayEl.style.setProperty('--blur-intensity', `${blurIntensity}px`);
		this.updateMask();
	}

	private updateSpotlightPosition(x: number, y: number) {
		this.currentX = x;
		this.currentY = y;
		this.updateMask();
	}

	private updateMask() {
		if (!this.overlayEl) return;

		const { spotlightWidth, spotlightHeight, horizontalOffset, featherEdge, spotlightShape, squareRoundness } = this.settings;
		const x = this.currentX + horizontalOffset;
		const y = this.currentY;
		const rx = spotlightWidth / 2;
		const ry = spotlightHeight / 2;
		const ribbonCutout = this.getRibbonCutout();

		let maskImage: string;

		switch (spotlightShape) {
			case 'square': {
				const minDimension = Math.min(rx, ry);
				const roundness = (squareRoundness / 100) * minDimension;
				maskImage = this.createSquareMask(x, y, spotlightWidth, spotlightHeight, roundness, featherEdge, ribbonCutout);
				break;
			}
			case 'circle':
			default: {
				const outerRx = rx + featherEdge;
				const outerRy = ry + featherEdge;
				const layers = [
					`radial-gradient(ellipse ${rx}px ${ry}px at ${x}px ${y}px, transparent 0%, transparent 100%, black 100%)`,
					`radial-gradient(ellipse ${outerRx}px ${outerRy}px at ${x}px ${y}px, transparent 0%, black 100%)`
				];
				if (ribbonCutout) {
					layers.push(`radial-gradient(circle ${ribbonCutout.radius}px at ${ribbonCutout.cx}px ${ribbonCutout.cy}px, transparent 0%, transparent 100%, black 100%)`);
				}
				maskImage = layers.join(', ');
				break;
			}
		}

		this.overlayEl.style.maskImage = maskImage;
	}

	private getRibbonCutout(): { cx: number; cy: number; radius: number } | null {
		if (!this.ribbonIconEl) return null;
		const rect = this.ribbonIconEl.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return null;
		return {
			cx: rect.left + rect.width / 2,
			cy: rect.top + rect.height / 2,
			radius: Math.max(rect.width, rect.height) / 2 + 8
		};
	}

	private createSquareMask(cx: number, cy: number, width: number, height: number, roundness: number, feather: number, ribbonCutout: { cx: number; cy: number; radius: number } | null): string {
		const left = cx - width / 2;
		const top = cy - height / 2;
		const outerLeft = left - feather;
		const outerTop = top - feather;
		const outerWidth = width + feather * 2;
		const outerHeight = height + feather * 2;
		const outerRoundness = roundness + feather;
		const ribbonHole = ribbonCutout
			? `<circle cx="${ribbonCutout.cx}" cy="${ribbonCutout.cy}" r="${ribbonCutout.radius}" fill="black"/>`
			: '';

		const svg = `
			<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
				<defs>
					<mask id="spotlight">
						<rect width="100%" height="100%" fill="white"/>
						<rect x="${outerLeft}" y="${outerTop}" width="${outerWidth}" height="${outerHeight}" rx="${outerRoundness}" fill="url(#fade)"/>
						<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="${roundness}" fill="black"/>
						${ribbonHole}
					</mask>
					<radialGradient id="fade">
						<stop offset="0%" stop-color="black"/>
						<stop offset="100%" stop-color="white"/>
					</radialGradient>
				</defs>
				<rect width="100%" height="100%" fill="black" mask="url(#spotlight)"/>
			</svg>
		`.replace(/\s+/g, ' ').trim();

		return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
	}

	private trackCursor() {
		if (!this.isActive) return;
		if (this.settings.trackingMode === 'mouse') return;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		// @ts-ignore - accessing internal CM6 editor
		const editorView: EditorView = view.editor.cm;
		if (!editorView) return;

		const cursorPos = editorView.state.selection.main.head;
		const coords = editorView.coordsAtPos(cursorPos);
		if (!coords) return;

		const centerY = (coords.top + coords.bottom) / 2;
		this.updateSpotlightPosition(coords.left, centerY);
	}

	private removeOverlay() {
		if (this.overlayEl) {
			this.overlayEl.remove();
			this.overlayEl = null;
		}
	}

	pauseOverlay() {
		this.wasActiveBeforePause = this.isActive;
		if (this.isActive) {
			this.removeOverlay();
			this.isActive = false;
			this.updateRibbonState();
		}
	}

	resumeOverlay() {
		if (this.wasActiveBeforePause && !this.isActive) {
			this.createOverlay();
			this.isActive = true;
			this.updateRibbonState();
		}
	}
}

class PrivacyScreenSettingTab extends PluginSettingTab {
	plugin: PrivacyScreenPlugin;
	private previewShapeEl: HTMLElement | null = null;
	private previewTextEl: HTMLElement | null = null;

	constructor(app: App, plugin: PrivacyScreenPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private addSliderWithInput(
		containerEl: HTMLElement,
		opts: { name: string; desc: string; min: number; max: number; step: number; value: number; onChange: (value: number) => void | Promise<void> }
	): void {
		let sliderComponent: SliderComponent | undefined;
		let textComponent: TextComponent | undefined;

		new Setting(containerEl)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addSlider(slider => {
				sliderComponent = slider;
				slider
					.setLimits(opts.min, opts.max, opts.step)
					.setValue(opts.value)
					.setDynamicTooltip()
					.onChange(async (value) => {
						textComponent?.setValue(String(value));
						await opts.onChange(value);
					});
			})
			.addText(text => {
				textComponent = text;
				text.inputEl.type = 'number';
				text.inputEl.addClass('privacy-number-input');
				text
					.setValue(String(opts.value))
					.onChange(async (raw) => {
						const parsed = Number(raw);
						if (Number.isNaN(parsed)) return;
						const clamped = Math.min(opts.max, Math.max(opts.min, parsed));
						sliderComponent?.setValue(clamped);
						if (clamped !== parsed) {
							text.setValue(String(clamped));
						}
						await opts.onChange(clamped);
					});
			});
	}

	display(): void {
		this.plugin.pauseOverlay();

		const { containerEl } = this;
		containerEl.empty();

		// Shape preview - text stays centered, shape moves around it
		const previewContainer = containerEl.createDiv({ cls: 'privacy-preview-container' });
		this.previewShapeEl = previewContainer.createDiv({ cls: 'privacy-preview-shape' });
		this.previewTextEl = previewContainer.createSpan({ text: 'text', cls: 'privacy-preview-text' });
		const cursorEl = previewContainer.createDiv({ cls: 'privacy-preview-cursor' });
		if (!this.plugin.settings.previewCursorBlink) {
			cursorEl.addClass('no-blink');
		}
		this.updatePreview();

		this.addSliderWithInput(containerEl, {
			name: 'Spotlight width',
			desc: 'Width of the clear area (in pixels)',
			min: 24,
			max: 600,
			step: 10,
			value: this.plugin.settings.spotlightWidth,
			onChange: async (value) => {
				this.plugin.settings.spotlightWidth = value;
				this.plugin.settings.horizontalOffset = this.plugin.clampOffsetToWidth(value, this.plugin.settings.horizontalOffset);
				await this.plugin.saveSettings();
				this.display();
			}
		});

		// Dynamic offset limits based on width
		const maxOffset = Math.floor(this.plugin.settings.spotlightWidth / 2) - 5;
		this.addSliderWithInput(containerEl, {
			name: 'Horizontal offset',
			desc: 'Shift spotlight left (-) or right (+) relative to cursor',
			min: -maxOffset,
			max: maxOffset,
			step: 1,
			value: this.plugin.settings.horizontalOffset,
			onChange: async (value) => {
				this.plugin.settings.horizontalOffset = value;
				await this.plugin.saveSettings();
				this.updatePreview();
			}
		});

		this.addSliderWithInput(containerEl, {
			name: 'Spotlight height',
			desc: 'Height of the clear area (in pixels)',
			min: 24,
			max: 600,
			step: 10,
			value: this.plugin.settings.spotlightHeight,
			onChange: async (value) => {
				this.plugin.settings.spotlightHeight = value;
				await this.plugin.saveSettings();
				this.updatePreview();
			}
		});

		this.addSliderWithInput(containerEl, {
			name: 'Blur intensity',
			desc: 'How blurry the surrounding area should be (in pixels)',
			min: 2,
			max: 20,
			step: 1,
			value: this.plugin.settings.blurIntensity,
			onChange: async (value) => {
				this.plugin.settings.blurIntensity = value;
				await this.plugin.saveSettings();
			}
		});

		this.addSliderWithInput(containerEl, {
			name: 'Feather edge',
			desc: 'Softness of the spotlight edge (in pixels)',
			min: 10,
			max: 100,
			step: 5,
			value: this.plugin.settings.featherEdge,
			onChange: async (value) => {
				this.plugin.settings.featherEdge = value;
				await this.plugin.saveSettings();
			}
		});

		new Setting(containerEl)
			.setName('Spotlight shape')
			.setDesc('Shape of the spotlight area')
			.addDropdown(dropdown => dropdown
				.addOption('circle', 'Circle')
				.addOption('square', 'Square')
				.setValue(this.plugin.settings.spotlightShape)
				.onChange(async (value: SpotlightShape) => {
					this.plugin.settings.spotlightShape = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.spotlightShape === 'square') {
			this.addSliderWithInput(containerEl, {
				name: 'Corner roundness',
				desc: 'Roundness of square corners (0 = sharp, 100 = circular)',
				min: 0,
				max: 100,
				step: 5,
				value: this.plugin.settings.squareRoundness,
				onChange: async (value) => {
					this.plugin.settings.squareRoundness = value;
					await this.plugin.saveSettings();
					this.updatePreview();
				}
			});
		}

		new Setting(containerEl)
			.setName('Tracking mode')
			.setDesc('Follow text cursor or mouse pointer')
			.addDropdown(dropdown => dropdown
				.addOption('cursor', 'Text cursor')
				.addOption('mouse', 'Mouse pointer')
				.setValue(this.plugin.settings.trackingMode)
				.onChange(async (value: TrackingMode) => {
					this.plugin.settings.trackingMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Preview cursor blink')
			.setDesc('Enable blinking animation for the cursor in preview')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.previewCursorBlink)
				.onChange(async (value) => {
					this.plugin.settings.previewCursorBlink = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Reset to defaults')
			.setDesc('Reset all settings above to their default values')
			.addButton(button => button
				.setButtonText('Reset')
				.setWarning()
				.onClick(async () => {
					await this.plugin.resetSettings();
					this.display();
				}));
	}

	hide(): void {
		this.plugin.resumeOverlay();
	}

	private updatePreview(): void {
		if (!this.previewShapeEl || !this.previewTextEl) return;

		const { spotlightWidth, spotlightHeight, horizontalOffset, spotlightShape, squareRoundness } = this.plugin.settings;

		// Calculate border radius
		let borderRadius: string;
		if (spotlightShape === 'circle') {
			borderRadius = '50%';
		} else {
			const minDim = Math.min(spotlightWidth, spotlightHeight) / 2;
			const roundness = (squareRoundness / 100) * minDim;
			borderRadius = `${roundness}px`;
		}

		// Use CSS custom properties instead of direct style manipulation
		this.previewShapeEl.setCssProps({
			'--preview-width': `${spotlightWidth}px`,
			'--preview-height': `${spotlightHeight}px`,
			'--preview-offset': `${horizontalOffset}px`,
			'--preview-radius': borderRadius
		});
	}
}
