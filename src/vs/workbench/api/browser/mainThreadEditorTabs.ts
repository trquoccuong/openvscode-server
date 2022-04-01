/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { ExtHostContext, IExtHostEditorTabsShape, MainContext, IEditorTabDto, IEditorTabGroupDto } from 'vs/workbench/api/common/extHost.protocol';
import { extHostNamedCustomer, IExtHostContext } from 'vs/workbench/services/extensions/common/extHostCustomers';
import { EditorResourceAccessor, IUntypedEditorInput, SideBySideEditor, DEFAULT_EDITOR_ASSOCIATION, GroupModelChangeKind } from 'vs/workbench/common/editor';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { SideBySideEditorInput } from 'vs/workbench/common/editor/sideBySideEditorInput';
import { columnToEditorGroup, EditorGroupColumn, editorGroupToColumn } from 'vs/workbench/services/editor/common/editorGroupColumn';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorsChangeEvent, IEditorService } from 'vs/workbench/services/editor/common/editorService';

@extHostNamedCustomer(MainContext.MainThreadEditorTabs)
export class MainThreadEditorTabs {

	private readonly _dispoables = new DisposableStore();
	private readonly _proxy: IExtHostEditorTabsShape;
	private _tabGroupModel: IEditorTabGroupDto[] = [];
	private readonly _tabModel: Map<number, IEditorTabDto[]> = new Map();

	constructor(
		extHostContext: IExtHostContext,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
	) {

		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostEditorTabs);

		// Queue all events that arrive on the same event loop and then send them as a batch
		this._dispoables.add(editorService.onDidEditorsChange((event) => this._updateTabsModel(event)));
		this._editorGroupsService.whenReady.then(() => this._createTabsModel());
	}

	dispose(): void {
		this._dispoables.dispose();
	}

	/**
	 * Creates a tab object with the correct properties
	 * @param editor The editor input represented by the tab
	 * @param group The group the tab is in
	 * @returns A tab object
	 */
	private _buildTabObject(editor: EditorInput, group: IEditorGroup): IEditorTabDto {
		// Even though the id isn't a diff / sideBySide on the main side we need to let the ext host know what type of editor it is
		const editorId = editor instanceof DiffEditorInput ? 'diff' : editor instanceof SideBySideEditorInput ? 'sideBySide' : editor.editorId;
		const tab: IEditorTabDto = {
			viewColumn: editorGroupToColumn(this._editorGroupsService, group),
			label: editor.getName(),
			resource: editor instanceof SideBySideEditorInput ? EditorResourceAccessor.getCanonicalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY }) : EditorResourceAccessor.getCanonicalUri(editor),
			editorId,
			additionalResourcesAndViewIds: [],
			isActive: group.isActive(editor)
		};
		tab.additionalResourcesAndViewIds.push({ resource: tab.resource, viewId: tab.editorId });
		if (editor instanceof SideBySideEditorInput) {
			tab.additionalResourcesAndViewIds.push({ resource: EditorResourceAccessor.getCanonicalUri(editor, { supportSideBySide: SideBySideEditor.SECONDARY }), viewId: editor.primary.editorId ?? editor.editorId });
		}
		return tab;
	}


	private _tabToUntypedEditorInput(tab: IEditorTabDto): IUntypedEditorInput {
		if (tab.editorId !== 'diff' && tab.editorId !== 'sideBySide') {
			return { resource: URI.revive(tab.resource), options: { override: tab.editorId } };
		} else if (tab.editorId === 'sideBySide') {
			return {
				primary: { resource: URI.revive(tab.resource), options: { override: tab.editorId } },
				secondary: { resource: URI.revive(tab.additionalResourcesAndViewIds[1].resource), options: { override: tab.additionalResourcesAndViewIds[1].viewId } }
			};
		} else {
			// For now only text diff editor are supported
			return {
				modified: { resource: URI.revive(tab.resource), options: { override: DEFAULT_EDITOR_ASSOCIATION.id } },
				original: { resource: URI.revive(tab.additionalResourcesAndViewIds[1].resource), options: { override: DEFAULT_EDITOR_ASSOCIATION.id } }
			};
		}
	}

	/**
	 * Called whenever a group activates, updates the model by marking the group as active an notifies the extension host
	 */
	private _onDidGroupActivate() {
		const activeGroupId = this._editorGroupsService.activeGroup.id;
		for (const group of this._tabGroupModel) {
			group.isActive = group.groupId === activeGroupId;
		}
	}

	/**
	 * Called when the tab label changes
	 * @param groupId The id of the group the tab exists in
	 * @param editorInput The editor input represented by the tab
	 * @param editorIndex The index of the editor within that group
	 */
	private _onDidTabLabelChange(groupId: number, editorInput: EditorInput, editorIndex: number) {
		this._tabGroupModel[groupId].tabs[editorIndex].label = editorInput.getName();
	}

	/**
	 * Called when a new tab is opened
	 * @param groupId The id of the group the tab is being created in
	 * @param editorInput The editor input being opened
	 * @param editorIndex The index of the editor within that group
	 */
	private _onDidTabOpen(groupId: number, editorInput: EditorInput, editorIndex: number) {
		const group = this._editorGroupsService.getGroup(groupId);
		if (!group) {
			return;
		}
		// Splice tab into group at index editorIndex
		this._tabGroupModel[groupId].tabs.splice(editorIndex, 0, this._buildTabObject(editorInput, group));
	}

	/**
 * Called when a tab is closed
 * @param groupId The id of the group the tab is being removed from
 * @param editorIndex The index of the editor within that group
 */
	private _onDidTabClose(groupId: number, editorIndex: number) {
		const group = this._editorGroupsService.getGroup(groupId);
		if (!group) {
			return;
		}
		// Splice tab into group at index editorIndex
		this._tabGroupModel[groupId].tabs.splice(editorIndex, 1);
		// If no tabs it's an empty group and gets deleted from the model
		// In the future we may want to support empty groups
		if (this._tabGroupModel[groupId].tabs.length === 0) {
			this._tabGroupModel.splice(groupId, 1);
		}
	}

	/**
	 * Called when the active tab changes
	 * @param groupId The id of the group the tab is contained in
	 * @param editorIndex The index of the tab
	 */
	private _onDidTabActiveChange(groupId: number, editorIndex: number) {
		const tabs = this._tabGroupModel[groupId].tabs;
		let activeTab: IEditorTabDto | undefined;
		for (let i = 0; i < tabs.length; i++) {
			if (i === editorIndex) {
				tabs[i].isActive = true;
				activeTab = tabs[i];
			} else {
				tabs[i].isActive = false;
			}
		}
		this._tabGroupModel[groupId].activeTab = activeTab;
	}

	/**
	 * Builds the model from scratch based on the current state of the editor service.
	 */
	private _createTabsModel(): void {
		this._tabGroupModel = [];
		this._tabModel.clear();
		let tabs: IEditorTabDto[] = [];
		for (const group of this._editorGroupsService.groups) {
			const currentTabGroupModel: IEditorTabGroupDto = {
				groupId: group.id,
				isActive: group.id === this._editorGroupsService.activeGroup.id,
				viewColumn: editorGroupToColumn(this._editorGroupsService, group),
				activeTab: undefined,
				tabs: []
			};
			for (const editor of group.editors) {
				const tab = this._buildTabObject(editor, group);
				// Mark the tab active within the group
				if (tab.isActive) {
					currentTabGroupModel.activeTab = tab;
				}
				tabs.push(tab);
			}
			currentTabGroupModel.tabs = tabs;
			this._tabGroupModel.push(currentTabGroupModel);
			this._tabModel.set(group.id, tabs);
			tabs = [];
		}
	}

	// TODOD @lramos15 Remove this after done finishing the tab model code
	// private _eventToString(event: IEditorsChangeEvent): string {
	// 	let eventString = '';
	// 	switch (event.kind) {
	// 		case GroupModelChangeKind.GROUP_INDEX: eventString += 'GROUP_INDEX'; break;
	// 		case GroupModelChangeKind.EDITOR_ACTIVE: eventString += 'EDITOR_ACTIVE'; break;
	// 		case GroupModelChangeKind.EDITOR_PIN: eventString += 'EDITOR_PIN'; break;
	// 		case GroupModelChangeKind.EDITOR_OPEN: eventString += 'EDITOR_OPEN'; break;
	// 		case GroupModelChangeKind.EDITOR_CLOSE: eventString += 'EDITOR_CLOSE'; break;
	// 		case GroupModelChangeKind.EDITOR_MOVE: eventString += 'EDITOR_MOVE'; break;
	// 		case GroupModelChangeKind.EDITOR_LABEL: eventString += 'EDITOR_LABEL'; break;
	// 		case GroupModelChangeKind.GROUP_ACTIVE: eventString += 'GROUP_ACTIVE'; break;
	// 		case GroupModelChangeKind.GROUP_LOCKED: eventString += 'GROUP_LOCKED'; break;
	// 		default: eventString += 'UNKNOWN'; break;
	// 	}
	// 	return eventString;
	// }

	/**
	 * The main handler for the tab events
	 * @param events The list of events to process
	 */
	private _updateTabsModel(event: IEditorsChangeEvent): void {
		switch (event.kind) {
			case GroupModelChangeKind.GROUP_ACTIVE:
				if (event.groupId === this._editorGroupsService.activeGroup.id) {
					this._onDidGroupActivate();
					break;
				} else {
					return;
				}
			case GroupModelChangeKind.EDITOR_LABEL:
				if (event.editor && event.editorIndex) {
					this._onDidTabLabelChange(event.groupId, event.editor, event.editorIndex);
					break;
				}
			case GroupModelChangeKind.EDITOR_OPEN:
				if (event.editor && event.editorIndex) {
					this._onDidTabOpen(event.groupId, event.editor, event.editorIndex);
					break;
				}
			case GroupModelChangeKind.EDITOR_CLOSE:
				if (event.editorIndex) {
					this._onDidTabClose(event.groupId, event.editorIndex);
					break;
				}
			case GroupModelChangeKind.EDITOR_ACTIVE:
				if (event.editorIndex) {
					this._onDidTabActiveChange(event.groupId, event.editorIndex);
					break;
				}
			default:
				// If it's not an optimized case we rebuild the tabs model from scratch
				this._createTabsModel();
		}
		// notify the ext host of the new model
		this._proxy.$acceptEditorTabModel(this._tabGroupModel);
	}
	//#region Messages received from Ext Host
	$moveTab(tab: IEditorTabDto, index: number, viewColumn: EditorGroupColumn): void {
		const groupId = columnToEditorGroup(this._editorGroupsService, viewColumn);
		let targetGroup: IEditorGroup | undefined;
		const sourceGroup = this._editorGroupsService.getGroup(columnToEditorGroup(this._editorGroupsService, tab.viewColumn));
		if (!sourceGroup) {
			return;
		}
		// If group index is out of bounds then we make a new one that's to the right of the last group
		if (this._tabModel.get(groupId) === undefined) {
			targetGroup = this._editorGroupsService.addGroup(this._editorGroupsService.groups[this._editorGroupsService.groups.length - 1], GroupDirection.RIGHT, undefined);
		} else {
			targetGroup = this._editorGroupsService.getGroup(groupId);
		}
		if (!targetGroup) {
			return;
		}

		// Similar logic to if index is out of bounds we place it at the end
		if (index < 0 || index > targetGroup.editors.length) {
			index = targetGroup.editors.length;
		}
		// Find the correct EditorInput using the tab info
		const editorInput = sourceGroup.editors.find(editor => editor.matches(this._tabToUntypedEditorInput(tab)));
		if (!editorInput) {
			return;
		}
		// Move the editor to the target group
		sourceGroup.moveEditor(editorInput, targetGroup, { index, preserveFocus: true });
		return;
	}

	async $closeTab(tab: IEditorTabDto): Promise<void> {
		const group = this._editorGroupsService.getGroup(columnToEditorGroup(this._editorGroupsService, tab.viewColumn));
		if (!group) {
			return;
		}
		const editorTab = this._tabToUntypedEditorInput(tab);
		const editor = group.editors.find(editor => editor.matches(editorTab));
		if (!editor) {
			return;
		}
		await group.closeEditor(editor);
	}
	//#endregion
}
