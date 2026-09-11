import { Loading } from '@paalstack/react-ui';

export default function OrgLoading() {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <Loading content="Loading workspace..." spinnerProps={{ size: 'lg' }} />
    </div>
  );
}
