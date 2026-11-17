/** The "Source in a Drop" mark: gulf blue on light surfaces, the reversed (white) drop in the dark theme. */
export function BrandMark({ className, size }: { className: string; size: number }) {
  return (
    <>
      <img className={`${className} brand-mark--light`} src="./sebeto-mark.svg" alt="" width={size} height={size} />
      <img className={`${className} brand-mark--dark`} src="./sebeto-mark-reversed.svg" alt="" width={size} height={size} />
    </>
  );
}

/** The mark plus the lowercase wordmark. */
export function Logo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="logo">
      <BrandMark className="logo__mark" size={36} />
      <div>
        <div className="logo__word" aria-label="Sebeto">sebeto</div>
        {subtitle && <div className="logo__sub">{subtitle}</div>}
      </div>
    </div>
  );
}
