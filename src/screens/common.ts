// OddsGlance — shared container factories for the three screens.
// Layout: 576x288 canvas. Every screen = one header TextContainer (id 1,
// display-only) + one ListContainer (id 2, event capture). containerID and
// containerName must match exactly between build and upgrade (DESIGN.md §4).

import {
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'

export const HEADER_ID = 1
export const HEADER_NAME = 'hdr'
export const LIST_ID = 2

export function headerText(content: string, height: number): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: HEADER_ID,
    containerName: HEADER_NAME,
    content,
    isEventCapture: 0,
  })
}

export function itemList(name: string, yPosition: number, height: number, items: string[]): ListContainerProperty {
  return new ListContainerProperty({
    xPosition: 0,
    yPosition,
    width: 576,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: LIST_ID,
    containerName: name,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: 568,
      isItemSelectBorderEn: 1,
      itemName: items,
    }),
  })
}

/** Full-screen single text page (loading / fatal states). */
export function fullText(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: HEADER_ID,
    containerName: HEADER_NAME,
    content,
    isEventCapture: 1,
  })
}
