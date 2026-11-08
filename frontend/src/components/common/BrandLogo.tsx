import logoSrc from '../../assets/logo.png'

export default function BrandLogo({
  className = '',
  size = 48,
}: {
  className?: string
  size?: number
}) {
  return (
    <img
      src={logoSrc}
      alt="Chunky"
      className={className}
      width={size}
      height={size}
      draggable={false}
    />
  )
}
