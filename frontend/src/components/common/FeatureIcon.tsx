import { IconMarkdown, IconScissors, IconSparkles, type IconProps } from './Icons'

const icons = { convert: IconMarkdown, chunk: IconScissors, enrich: IconSparkles }

/** One visual identity per operation, shared by actions, tabs, and status. */
export default function FeatureIcon({ feature, ...props }: IconProps & { feature: keyof typeof icons }) {
  const Icon = icons[feature]
  return <Icon data-feature-icon={feature} {...props} />
}
