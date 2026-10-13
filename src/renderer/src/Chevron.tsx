import { Icon } from './icons/Icon'

/**
 * A disclosure chevron: one symbol pointing down while its section is open,
 * turned to point `closed` (right for a notebook, up for a sidebar section)
 * while it is shut. It turns over `motion.duration.toggle` (app.css
 * `.chevron`); Reduce Motion turns it at once.
 */
export function Chevron(props: { open: boolean; closed: 'right' | 'up' }) {
  return (
    <span className="chevron" data-turn={props.open ? undefined : props.closed}>
      <Icon name="disclosure.open" size="sm" />
    </span>
  )
}
