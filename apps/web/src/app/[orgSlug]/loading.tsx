import { Loading } from '@paalstack/react-ui';

export default function OrgLoading() {
  return (
    <div className="flex min-h-80vh] w-full items-center justify-center">
      <Loading content="Loading workspace..." className='text-foreground' spinnerProps={{ size: 'lg' }} />
    </div>
  );
}
