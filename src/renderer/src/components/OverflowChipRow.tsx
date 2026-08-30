import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type OverflowChipSurface = 'row' | 'menu' | 'measurement';

export interface OverflowChipRenderContext {
  selected: boolean;
  surface: OverflowChipSurface;
  onSelect: () => void;
}

interface OverflowChipRowProps<T> {
  items: readonly T[];
  selectedId: string | null;
  getItemId: (item: T) => string;
  onRowSelect: (item: T) => void;
  onMenuSelect: (item: T) => void;
  renderItem: (item: T, context: OverflowChipRenderContext) => ReactNode;
  renderTrailing?: (surface: OverflowChipSurface) => ReactNode;
  wrapperClassName: string;
  rowClassName: string;
  fadeClassName: string;
  menuAriaLabel: string;
  /** Extra overflow entries that move into the menu with the chip list. */
  overflowCount?: number;
}

export function OverflowChipRow<T>({
  items,
  selectedId,
  getItemId,
  onRowSelect,
  onMenuSelect,
  renderItem,
  renderTrailing,
  wrapperClassName,
  rowClassName,
  fadeClassName,
  menuAriaLabel,
  overflowCount
}: OverflowChipRowProps<T>): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const selectedItem = items.find((item) => getItemId(item) === selectedId) ?? items[0];
  const hiddenCount = Math.max(overflowCount ?? items.length - 1, 0);

  const renderItems = (surface: OverflowChipSurface, select: (item: T) => void): ReactNode[] =>
    items.map((item) => (
      <Fragment key={getItemId(item)}>
        {renderItem(item, {
          selected: getItemId(item) === selectedId,
          surface,
          onSelect: () => select(item)
        })}
      </Fragment>
    ));

  const measureOverflow = (): void => {
    const wrapper = wrapperRef.current;
    const measurement = measurementRef.current;
    if (!wrapper || !measurement) return;
    setIsOverflowing(measurement.scrollWidth > wrapper.clientWidth + 1);
  };

  useLayoutEffect(() => {
    measureOverflow();
  }, [items, selectedId]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const measurement = measurementRef.current;
    if (!wrapper || !measurement) return;

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(wrapper);
    observer.observe(measurement);
    measureOverflow();
    return () => observer.disconnect();
  }, [items, selectedId]);

  useEffect(() => {
    if (!isOverflowing) {
      setMenuOpen(false);
      return;
    }

    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOverflowing, menuOpen]);

  const handleMenuSelect = (item: T): void => {
    onMenuSelect(item);
    setMenuOpen(false);
  };

  return (
    <div ref={wrapperRef} className={`${wrapperClassName} overflow-chip-row-wrap${isOverflowing ? ' is-overflowing' : ''}`}>
      {isOverflowing ? (
        <div className="overflow-chip-controls">
          <nav className={`${rowClassName} overflow-chip-selected-row`} aria-label={menuAriaLabel}>
            {selectedItem &&
              renderItem(selectedItem, {
                selected: getItemId(selectedItem) === selectedId,
                surface: 'row',
                onSelect: () => onRowSelect(selectedItem)
              })}
          </nav>
          <button
            type="button"
            className="overflow-chip-trigger"
            aria-label={`show ${items.length} ${menuAriaLabel}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            +{hiddenCount} <span aria-hidden="true">▾</span>
          </button>
        </div>
      ) : (
        <nav className={rowClassName} aria-label={menuAriaLabel}>
          {renderItems('row', onRowSelect)}
          {renderTrailing?.('row')}
        </nav>
      )}

      <nav ref={measurementRef} className={`${rowClassName} overflow-chip-measurement`} aria-hidden="true">
        {renderItems('measurement', () => undefined)}
        {renderTrailing?.('measurement')}
      </nav>

      {!isOverflowing && <div className={fadeClassName} aria-hidden="true" />}

      {isOverflowing && menuOpen && (
        <div className="overflow-chip-menu" role="menu" aria-label={menuAriaLabel}>
          {renderItems('menu', handleMenuSelect)}
          {renderTrailing && <div className="overflow-chip-menu-footer">{renderTrailing('menu')}</div>}
        </div>
      )}
    </div>
  );
}
