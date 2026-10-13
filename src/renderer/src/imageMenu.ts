// The image context menu: a native menu for an image in the preview or under
// its line in the editor. Copy Image and Save Image As… work on attachments
// (Rust reads their bytes by ID); the Size submenu sets the size preset in
// the note's Markdown (core/images.ts). Its items are registry commands, so
// the palette and any keys the user gives them act on the image at the
// cursor too.
import { invoke } from './ipc'
import { useCallback } from 'react'
import { IMAGE_SIZES, type ImageSize } from '../../core/images'
import { editorCommandKeys, type CommandId } from './commands/registry'
import {
  commandEntry,
  shownGroups,
  useContextMenu,
  type MenuEntry,
  type MenuGroups,
  type MenuPoint,
} from './contextMenu'
import type { EditorImage } from './editor/images'

/** `size` names the Size submenu; its items pick `size.<preset>`. */
export type ImageAction = 'copy' | 'save' | 'size' | `size.${ImageSize}`

/** An image as it is in the note's Markdown (see editor/images.ts). */
export interface ImageSource {
  from: number
  to: number
  text: string
}

/** What the menu needs to know about the image that was right-clicked. */
export interface ImageMenuTarget {
  /** The attachment it shows, if it is one. */
  fileId: string | null
  /** Where it is in the Markdown; null when its size cannot be set there. */
  source: ImageSource | null
  size: ImageSize
}

/** The registry command behind each action (its label and keys). */
export const IMAGE_COMMANDS: Readonly<Record<Exclude<ImageAction, 'size'>, CommandId>> = {
  copy: 'image.copy',
  save: 'image.save',
  'size.auto': 'image.sizeAuto',
  'size.small': 'image.sizeSmall',
  'size.half': 'image.sizeHalf',
  'size.full': 'image.sizeFull',
}

/** The image commands' keys in effect (none by default), in CodeMirror key notation. */
export function imageKeys(): { action: Exclude<ImageAction, 'size'>; key: string }[] {
  return (Object.entries(IMAGE_COMMANDS) as [Exclude<ImageAction, 'size'>, CommandId][]).flatMap(
    ([action, id]) => editorCommandKeys(id).map((key) => ({ action, key })),
  )
}

const isAttachment = (image: ImageMenuTarget) => image.fileId !== null

const SIZE_ITEMS: MenuEntry<ImageAction, ImageMenuTarget>[] = IMAGE_SIZES.map((size) =>
  commandEntry<ImageAction, ImageMenuTarget>(`size.${size}`, IMAGE_COMMANDS[`size.${size}`], {
    label: `imageMenu.size.${size}`,
    checked: (image) => image.size === size,
  }),
)

export const IMAGE_MENU: MenuGroups<ImageAction, ImageMenuTarget> = [
  [
    commandEntry('copy', IMAGE_COMMANDS.copy, { shown: isAttachment }),
    commandEntry('save', IMAGE_COMMANDS.save, { shown: isAttachment }),
  ],
  [
    {
      action: 'size',
      label: 'imageMenu.size',
      shown: (image) => image.source !== null,
      submenu: SIZE_ITEMS,
    },
  ],
]

/** Whether the menu has anything to show for an image. */
export const imageMenuHasItems = (image: ImageMenuTarget): boolean =>
  shownGroups(IMAGE_MENU, image).length > 0

/** The size a Size item picks, or undefined for other actions. */
export function sizeOfAction(action: ImageAction): ImageSize | undefined {
  const size = action.startsWith('size.') ? action.slice('size.'.length) : undefined
  return IMAGE_SIZES.find((s) => s === size)
}

/** Copy Image: the attachment's bytes go on the pasteboard as image data (Rust). */
export function copyImage(fileId: string): Promise<void> {
  return invoke('image_copy', { id: fileId })
}

/** Save Image As…: Rust asks where, then writes it; true once saved. */
export function saveImage(fileId: string): Promise<boolean> {
  return invoke<boolean>('image_save', { id: fileId })
}

/** The menu's target for an image found in the editor's text. */
export function imageMenuTarget(image: EditorImage): ImageMenuTarget {
  return {
    fileId: image.fileId,
    source: image.sizable ? { from: image.from, to: image.to, text: image.text } : null,
    size: image.size,
  }
}

/** Sets the size of an image in the open note's Markdown (the editor does it). */
export type SetImageSize = (source: ImageSource, size: ImageSize) => void

/** Whether an action can act on this image: its menu item (or its submenu) shows. */
export function imageActionApplies(action: ImageAction, image: ImageMenuTarget): boolean {
  if (action === 'size') return false
  const item = sizeOfAction(action) === undefined ? action : 'size'
  return shownGroups(IMAGE_MENU, image).some((group) => group.some((e) => e.action === item))
}

/** Runs an image action on an image; a failure is logged by code. */
export function runImageAction(
  action: ImageAction,
  image: ImageMenuTarget,
  setSize: SetImageSize,
): Promise<unknown> | void {
  if (!imageActionApplies(action, image)) return
  const fileId = image.fileId
  if (action === 'copy' && fileId) {
    return copyImage(fileId).catch(() => console.warn('W_IMAGE_COPY_FAILED', fileId))
  }
  if (action === 'save' && fileId) {
    return saveImage(fileId).catch(() => console.warn('W_IMAGE_SAVE_FAILED', fileId))
  }
  const size = sizeOfAction(action)
  if (size && image.source) setSize(image.source, size)
}

/** Shows the image menu for an image at a point in the window. */
export type ShowImageMenu = (image: ImageMenuTarget, at: MenuPoint) => void

/** The image menu for this window; a pick acts on the image it was opened for. */
export function useImageMenu(setSize: SetImageSize): ShowImageMenu {
  const pick = useCallback(
    (action: ImageAction, image: ImageMenuTarget) => void runImageAction(action, image, setSize),
    [setSize],
  )
  const show = useContextMenu('image', IMAGE_MENU, pick)
  return useCallback(
    (image: ImageMenuTarget, at: MenuPoint) => {
      if (imageMenuHasItems(image)) void show(image, at)
    },
    [show],
  )
}
