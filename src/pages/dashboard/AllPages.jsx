import { useAllTopics } from '../../hooks/useTopics';
import PageManager from './PageManager';

/**
 * Administrators only. Shows every page in the system, private ones
 * included — which is not a frontend decision: the same query run by a
 * member returns only what the topics policies let them read.
 */
export function AllPages() {
  const query = useAllTopics();

  return (
    <PageManager
      title="All pages"
      showOwner
      query={query}
      empty={{ title: 'No pages exist yet', hint: 'Nobody has created anything on this site.' }}
    />
  );
}

export default AllPages;
