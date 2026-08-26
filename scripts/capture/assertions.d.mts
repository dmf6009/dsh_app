export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

export interface ActionBtn {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bounds {
  viewport: { w: number; h: number };
  noPageHScroll: boolean;
  pageScrollWidth: number;
  pageClientWidth: number;
  toolbar: Rect | null;
  actionBtns: ActionBtn[];
}

export function rectVisible(rect: Rect | null): boolean;
export function rectInViewport(rect: Rect | null, vw: number): boolean;
export function noHScrollErrors(b: Bounds): string[];
export function toolbarErrors(b: Bounds): string[];
export function overlapErrors(btns: Array<Pick<ActionBtn, 'x' | 'y' | 'w' | 'h'>>): string[];
export function actionsBarErrors(b: Bounds, expectedLabels?: string[]): string[];
