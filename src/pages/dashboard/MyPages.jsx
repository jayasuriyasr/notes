import { useAuth } from '../../hooks/useAuth';
import { useMyTopics } from '../../hooks/useTopics';
import PageManager from './PageManager';

export function MyPages() {
  const { profile } = useAuth();
  const query = useMyTopics(profile?.id);

  return (
    <PageManager
      title="My pages"
      query={query}
      empty={{
        title: 'You have not written anything yet',
        hint: 'Create a page, then choose whether to keep it private, publish it, or let other members edit it.',
      }}
    />
  );
}

export default MyPages;
