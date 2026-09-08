import importlib.machinery, importlib.util, os, subprocess, tempfile, time, unittest, json
from pathlib import Path
CHECK=str(Path(__file__).resolve().parents[1] / 'bin/check')
class CheckTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.repo=self.root/'repo';self.repo.mkdir();(self.repo/'Test.csproj').write_text('<Project/>')
  subprocess.run(['git','init','-q',str(self.repo)],check=True);subprocess.run(['git','-C',str(self.repo),'add','.'],check=True);subprocess.run(['git','-C',str(self.repo),'-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','initial'],check=True)
  self.bin=self.root/'bin';self.bin.mkdir();d=self.bin/'dotnet';d.write_text('#!/bin/sh\necho "$1" >> "$CHECK_CALLS"\nsleep .25\nif [ "$1" = "$CHECK_FAIL" ]; then exit 7; fi\n');d.chmod(0o755)
  self.env={**os.environ,'PATH':str(self.bin)+':'+os.environ['PATH'],'LOOP_CHECK_ROOT':str(self.root/'checks'),'CHECK_CALLS':str(self.root/'calls')}
 def tearDown(self):self.tmp.cleanup()
 def call(self,*args):return json.loads(subprocess.check_output([CHECK,*args,str(self.repo)] if args==('status',) else [CHECK,'start',str(self.repo),'Test.csproj'],env=self.env))
 def finish(self):
  for i in range(150):
   s=self.call('status')
   if s['status'] not in ('running','starting'):return s
   time.sleep(.05)
  self.fail('worker never finished')
 def test_single_writer_and_all_stages(self):
  self.call('start');duplicate=self.call('start');self.assertTrue(duplicate['already_running']);s=self.finish();self.assertEqual(s['status'],'succeeded');self.assertEqual((self.root/'calls').read_text().splitlines(),['restore','build','test']);self.assertTrue(Path(s['run_dir'],'result.json').exists())
 def test_failure_stops_next_stage(self):
  self.env['CHECK_FAIL']='build';self.call('start');s=self.finish();self.assertEqual(s['status'],'failed');self.assertEqual(s['results']['build']['exit_code'],7);self.assertEqual((self.root/'calls').read_text().splitlines(),['restore','build'])
 def test_dead_worker_is_interrupted_and_restartable(self):
  self.call('start')
  for i in range(50):
   s=self.call('status')
   if 'pid' in s:break
   time.sleep(.01)
  os.killpg(s['pid'],9);
  subprocess.run(['pkill','-f',str(self.bin/'dotnet')],check=False)
  time.sleep(.4);self.assertEqual(self.call('status')['status'],'interrupted');self.call('start');self.assertEqual(self.finish()['status'],'succeeded')
 def test_descendants_cannot_keep_the_lock_after_completion(self):
  d=self.bin/'dotnet';d.write_text('#!/bin/sh\nsleep 20 &\nsleep .1\n');d.chmod(0o755)
  self.call('start');s=self.finish();self.assertEqual(s['status'],'succeeded')
  again=self.call('start');self.assertNotIn('already_running',again);self.assertEqual(self.finish()['status'],'succeeded')
 def test_source_change_invalidates_pass(self):
  self.call('start');(self.repo/'Test.csproj').write_text('changed');s=self.finish();self.assertEqual(s['status'],'failed');self.assertIn('changed',s['reason'])
 def test_frontend_auth_failure_stops_before_dotnet(self):
  frontend=self.repo/'src/Lionrock/service/Lionrock.WebApp/ClientApp';frontend.mkdir(parents=True);(frontend/'package-lock.json').write_text('{}')
  node=self.bin/'node';node.write_text('#!/bin/sh\nexit 7\n');node.chmod(0o755)
  self.call('start');s=self.finish();self.assertEqual(s['status'],'failed');self.assertEqual(s['results']['frontend-restore']['exit_code'],7);self.assertFalse((self.root/'calls').exists())
if __name__=='__main__':unittest.main()
